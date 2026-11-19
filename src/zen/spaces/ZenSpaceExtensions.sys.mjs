/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  ZenSessionStore: "resource:///modules/zen/ZenSessionManager.sys.mjs",
});

// Read by ExtensionContent.sys.mjs before injecting content scripts. Each
// tab whose space turns extensions off gets its own key, holding their IDs.
const SHARED_DATA_PREFIX = "zen-space-disabled-extensions:";

/**
 * Lets the user turn extensions off per Space. Spaces store the IDs of the
 * extensions they disable in `disabledExtensions`. In tabs of such a space
 * those extensions don't inject content scripts, and their toolbar buttons
 * are hidden while the space is active.
 */
class nsZenSpaceExtensions {
  // Space ID -> IDs of the extensions turned off in it
  #disabledBySpace = new Map();
  // Browser ID -> IDs of the extensions turned off in its tab
  #disabledByBrowser = new Map();
  #windows = new WeakSet();
  // Little windows have no spaces. Their tabs go to the last active space by
  // default, so that is the one they follow.
  #littleWindows = new Set();
  #lastActiveSpace = null;
  // Essential tab -> ID of the space it last followed
  #essentialSpaces = new WeakMap();
  // Whether a window has told us about the spaces yet
  #hasSpaces = false;
  // Whether there are changes content processes don't know about yet
  #dirty = false;

  /**
   * Called by every window as it starts up. Its spaces aren't restored yet
   * when it loads its first page, so its tabs get what the last active space
   * turns off until they are.
   *
   * @param {Window} aWindow - The window that opened.
   */
  onWindowOpened(aWindow) {
    const isLittleWindow =
      aWindow.document.documentElement.hasAttribute("zen-little-window") &&
      !aWindow.gZenWorkspaces.isPrivateWindow;
    if (!isLittleWindow && !this.#isSpacesWindow(aWindow)) {
      return;
    }
    // The window has no tabs yet
    const observer = subject => {
      if (subject !== aWindow) {
        return;
      }
      Services.obs.removeObserver(observer, "browser-window-before-show");
      if (this.#windows.has(aWindow)) {
        return;
      }
      if (!this.#hasSpaces) {
        this.#setSpaces(lazy.ZenSessionStore.getClonedSpaces());
      }
      if (isLittleWindow) {
        this.#littleWindows.add(aWindow);
        this.#trackTabs(aWindow);
      }
      const disabled = this.#disabledBySpace.get(this.#getLastActiveSpace());
      for (const tab of aWindow.gBrowser.tabs) {
        this.#setDisabled(tab.linkedBrowser?.browserId, disabled);
      }
      this.#flush();
    };
    Services.obs.addObserver(observer, "browser-window-before-show");
  }

  #getLastActiveSpace() {
    return (
      this.#lastActiveSpace ??
      Services.prefs.getStringPref("zen.workspaces.active", "")
    );
  }

  /**
   * Called by every window once its spaces are restored, before its tabs
   * load.
   *
   * @param {Window} aWindow - The window to start tracking.
   */
  addWindow(aWindow) {
    if (!this.#isSpacesWindow(aWindow) || this.#windows.has(aWindow)) {
      return;
    }
    this.#windows.add(aWindow);
    this.#trackTabs(aWindow);
    // Tabs are moved between spaces by changing this attribute
    new aWindow.MutationObserver(mutations => {
      if (!this.#disabledBySpace.size) {
        return;
      }
      for (const { target } of mutations) {
        if (aWindow.gBrowser.isTab(target)) {
          this.#updateTab(aWindow, target);
        }
      }
      this.#flush();
    }).observe(aWindow.gNavToolbox, {
      subtree: true,
      attributeFilter: ["zen-workspace-id"],
    });
    this.onSpacesChanged(aWindow);
    this.#updateWindow(aWindow);
    this.#flush();
  }

  #trackTabs(aWindow) {
    for (const type of ["TabOpen", "TabBrowserInserted", "TabClose"]) {
      aWindow.addEventListener(type, event => this.#onTabEvent(aWindow, event));
    }
    // Tabs moved to another window, and tabs window sync shows in two
    // windows, swap browsers. The event doesn't bubble.
    aWindow.addEventListener(
      "EndSwapDocShells",
      event => this.#onBrowserSwapped(aWindow, event.target),
      true
    );
    aWindow.addEventListener(
      "unload",
      () => {
        this.#littleWindows.delete(aWindow);
        this.#onWindowClosed();
      },
      { once: true }
    );
  }

  /**
   * Called by every window once its space data changed.
   *
   * @param {Window} aWindow - The window whose spaces changed.
   */
  onSpacesChanged(aWindow) {
    if (!this.#isSpacesWindow(aWindow)) {
      return;
    }
    this.#hasSpaces = true;
    // All windows share the same spaces, so only the first one to report a
    // change has work to do.
    if (!this.#setSpaces(aWindow.gZenWorkspaces.getWorkspaces())) {
      return;
    }
    this.#updateAllWindows();
    this.#flush();
  }

  #updateAllWindows() {
    for (const win of lazy.BrowserWindowTracker.orderedWindows) {
      this.#updateWindow(win);
    }
    for (const win of this.#littleWindows) {
      this.#updateWindow(win);
    }
  }

  /**
   * @param {object[]} aSpaces - The spaces to read `disabledExtensions` from.
   * @returns {boolean} Whether any space turns other extensions off now.
   */
  #setSpaces(aSpaces) {
    const disabledBySpace = new Map();
    for (const space of aSpaces) {
      if (space.disabledExtensions?.length) {
        disabledBySpace.set(space.uuid, space.disabledExtensions);
      }
    }
    if (
      JSON.stringify([...disabledBySpace]) ===
      JSON.stringify([...this.#disabledBySpace])
    ) {
      return false;
    }
    this.#disabledBySpace = disabledBySpace;
    return true;
  }

  #onTabEvent(aWindow, event) {
    const tab = event.target;
    if (event.type === "TabClose") {
      // Closed tabs never load again, so this can wait for the next flush
      this.#setDisabled(tab.linkedBrowser?.browserId, undefined);
      return;
    }
    if (!this.#disabledBySpace.size) {
      return;
    }
    // The tab starts loading right after this, so publish right away
    this.#updateTab(aWindow, tab);
    this.#flush();
  }

  #onBrowserSwapped(aWindow, aBrowser) {
    const tab = aWindow.gBrowser.getTabForBrowser(aBrowser);
    if (!tab) {
      return;
    }
    if (tab.closing) {
      // The tab moved to another window, which left us its placeholder
      this.#setDisabled(aBrowser.browserId, undefined);
    } else {
      this.#updateTab(aWindow, tab);
    }
    this.#flush();
  }

  #isSpacesWindow(aWindow) {
    return (
      !aWindow.closed &&
      aWindow.gZenWorkspaces?.workspaceEnabled &&
      !aWindow.gZenWorkspaces.privateWindowOrDisabled
    );
  }

  /**
   * Called by every window as soon as it switches spaces.
   *
   * @param {Window} aWindow - The window that switched.
   */
  onActiveSpaceChanged(aWindow) {
    // Windows aren't tracked until their spaces are restored
    if (!this.#windows.has(aWindow) || !this.#isSpacesWindow(aWindow)) {
      return;
    }
    this.#lastActiveSpace = aWindow.gZenWorkspaces.activeWorkspace;
    this.#updateToolbar(aWindow);
    if (!this.#disabledBySpace.size) {
      return;
    }
    // Essentials are the only tabs that follow the active space
    for (const tab of aWindow.gZenWorkspaces.allStoredTabs) {
      if (!tab.hasAttribute("zen-workspace-id")) {
        this.#updateTab(aWindow, tab);
      }
    }
    for (const win of this.#littleWindows) {
      this.#updateWindow(win);
    }
    this.#flush();
  }

  #onWindowClosed() {
    if (!this.#disabledByBrowser.size) {
      return;
    }
    // Tabs of closed windows don't get a TabClose, so drop the browsers
    // that are gone.
    const browserIds = new Set();
    for (const win of lazy.BrowserWindowTracker.orderedWindows) {
      if (this.#isSpacesWindow(win)) {
        for (const tab of win.gZenWorkspaces.allStoredTabs) {
          browserIds.add(tab.linkedBrowser?.browserId);
        }
      }
    }
    for (const win of this.#littleWindows) {
      for (const tab of win.gBrowser.tabs) {
        browserIds.add(tab.linkedBrowser?.browserId);
      }
    }
    for (const browserId of this.#disabledByBrowser.keys()) {
      if (!browserIds.has(browserId)) {
        this.#setDisabled(browserId, undefined);
      }
    }
  }

  #updateWindow(aWindow) {
    if (this.#littleWindows.has(aWindow)) {
      for (const tab of aWindow.gBrowser.tabs) {
        this.#updateTab(aWindow, tab);
      }
      return;
    }
    if (!this.#isSpacesWindow(aWindow)) {
      return;
    }
    this.#updateToolbar(aWindow);
    for (const tab of aWindow.gZenWorkspaces.allStoredTabs) {
      this.#updateTab(aWindow, tab);
    }
  }

  #updateTab(aWindow, aTab) {
    this.#setDisabled(
      aTab.linkedBrowser?.browserId,
      this.#disabledBySpace.get(this.#getSpaceId(aWindow, aTab))
    );
  }

  #getSpaceId(aWindow, aTab) {
    if (this.#littleWindows.has(aWindow)) {
      return this.#getLastActiveSpace();
    }
    const { gZenWorkspaces } = aWindow;
    const spaceId = aTab.getAttribute("zen-workspace-id");
    if (spaceId || !aTab.hasAttribute("zen-essential")) {
      return spaceId || gZenWorkspaces.activeWorkspace;
    }
    // Essentials have no space of their own. They follow the active space
    // while it shows them, and keep the last one that did otherwise.
    const spaces = gZenWorkspaces.getWorkspaces();
    const space = [
      gZenWorkspaces.getWorkspaceFromId(gZenWorkspaces.activeWorkspace),
      gZenWorkspaces.getWorkspaceFromId(this.#essentialSpaces.get(aTab)),
      ...spaces,
    ].find(
      candidate =>
        candidate &&
        gZenWorkspaces._shouldShowTab(
          aTab,
          candidate.uuid,
          candidate.containerTabId,
          spaces
        )
    );
    if (!space) {
      return gZenWorkspaces.activeWorkspace;
    }
    this.#essentialSpaces.set(aTab, space.uuid);
    return space.uuid;
  }

  /**
   * @param {number} aBrowserId - The tab's browser ID, if it has one yet.
   * @param {string[]} [aDisabled] - The extension IDs to turn off.
   */
  #setDisabled(aBrowserId, aDisabled) {
    if (!aBrowserId || this.#disabledByBrowser.get(aBrowserId) === aDisabled) {
      return;
    }
    const key = SHARED_DATA_PREFIX + aBrowserId;
    if (aDisabled) {
      this.#disabledByBrowser.set(aBrowserId, aDisabled);
      Services.ppmm.sharedData.set(key, aDisabled);
    } else {
      this.#disabledByBrowser.delete(aBrowserId);
      Services.ppmm.sharedData.delete(key);
    }
    this.#dirty = true;
  }

  #flush() {
    if (this.#dirty) {
      this.#dirty = false;
      Services.ppmm.sharedData.flush();
    }
  }

  /**
   * Hides the toolbar buttons and extensions panel entries of the
   * extensions turned off in the window's active space.
   *
   * @param {Window} aWindow - The window to update.
   */
  #updateToolbar(aWindow) {
    const doc = aWindow.document;
    const disabled =
      this.#disabledBySpace.get(aWindow.gZenWorkspaces.activeWorkspace) ?? [];
    let style = doc.getElementById("zen-space-extensions-style");
    if (!disabled.length) {
      style?.remove();
      return;
    }
    if (!style) {
      style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
      style.id = "zen-space-extensions-style";
      doc.head.appendChild(style);
    }
    const selectors = disabled.map(id => {
      id = aWindow.CSS.escape(id);
      return `[data-extensionid="${id}"], [extension-id="${id}"]`;
    });
    // Still shown while customizing, so the buttons can be moved around
    style.textContent = `:root:not([customizing]) .unified-extensions-item:is(${selectors.join(", ")}) { display: none !important; }`;
  }

  /**
   * Fills a menupopup with a checkbox per active extension, checked when the
   * extension is allowed in the given space.
   *
   * @param {Element} aPopup - The menupopup to fill.
   * @param {string} aSpaceId - The space the menu applies to.
   */
  async populateMenu(aPopup, aSpaceId) {
    const doc = aPopup.ownerDocument;
    const { gZenWorkspaces } = doc.defaultView;
    const addons = (await lazy.AddonManager.getAddonsByTypes(["extension"]))
      .filter(addon => !addon.isSystem && !addon.hidden && addon.isActive)
      .sort((a, b) => a.name.localeCompare(b.name));
    aPopup.replaceChildren();
    if (!addons.length) {
      const item = doc.createXULElement("menuitem");
      doc.l10n.setAttributes(item, "zen-workspaces-panel-extensions-empty");
      item.disabled = true;
      aPopup.appendChild(item);
      return;
    }
    const disabled = new Set(
      gZenWorkspaces.getWorkspaceFromId(aSpaceId)?.disabledExtensions
    );
    for (const addon of addons) {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("type", "checkbox");
      item.setAttribute("label", addon.name);
      item.toggleAttribute("checked", !disabled.has(addon.id));
      item.addEventListener("command", () => {
        // Read the space again, it may have been synced meanwhile
        const space = gZenWorkspaces.getWorkspaceFromId(aSpaceId);
        if (!space) {
          return;
        }
        const spaceDisabled = new Set(space.disabledExtensions);
        if (item.hasAttribute("checked")) {
          spaceDisabled.delete(addon.id);
        } else {
          spaceDisabled.add(addon.id);
        }
        gZenWorkspaces.saveWorkspace({
          ...space,
          disabledExtensions: [...spaceDisabled],
        });
      });
      aPopup.appendChild(item);
    }
  }
}

export const gZenSpaceExtensions = new nsZenSpaceExtensions();
