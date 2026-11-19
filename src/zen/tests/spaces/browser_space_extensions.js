/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { gZenSpaceExtensions } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenSpaceExtensions.sys.mjs"
);

const PAGE = "https://example.com/";

// Each extension marks the page so we can tell which content scripts ran.
// "sentinel" is never disabled and runs last, so once it has marked the page
// every other content script would have run too.
async function loadMarkerExtension(name, runAt = "document_start") {
  const ext = ExtensionTestUtils.loadExtension({
    manifest: {
      name,
      browser_specific_settings: { gecko: { id: `${name}@zen-test` } },
      content_scripts: [
        { matches: ["https://example.com/*"], js: ["cs.js"], run_at: runAt },
      ],
    },
    files: {
      "cs.js": `document.documentElement.setAttribute("data-${name}", "");`,
    },
    useAddonManager: "temporary",
  });
  await ext.startup();
  return ext;
}

async function loadMarkerExtensions() {
  return {
    extA: await loadMarkerExtension("exta"),
    extB: await loadMarkerExtension("extb"),
    sentinel: await loadMarkerExtension("sentinel", "document_idle"),
  };
}

async function unloadAll(extensions) {
  for (const ext of Object.values(extensions)) {
    await ext.unload();
  }
}

async function getMarkers(tab) {
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    ContentTaskUtils.waitForCondition(() =>
      content.document.documentElement.hasAttribute("data-sentinel")
    )
  );
  return SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
    a: content.document.documentElement.hasAttribute("data-exta"),
    b: content.document.documentElement.hasAttribute("data-extb"),
  }));
}

async function addSpace(name) {
  return (await gZenWorkspaces.createAndSaveWorkspace(name, "", true)).uuid;
}

async function setDisabledExtensions(spaceId, disabledExtensions) {
  const space = gZenWorkspaces.getWorkspaceFromId(spaceId);
  gZenWorkspaces.saveWorkspace({ ...space, disabledExtensions });
  // Windows pick up space changes asynchronously
  await TestUtils.waitForTick();
}

async function resetSpace(spaceId) {
  const { disabledExtensions: _, ...space } =
    gZenWorkspaces.getWorkspaceFromId(spaceId);
  gZenWorkspaces.saveWorkspace(space);
  await TestUtils.waitForTick();
}

function waitForDisabled(tab, expected) {
  const key = `zen-space-disabled-extensions:${tab.linkedBrowser.browserId}`;
  return TestUtils.waitForCondition(
    () =>
      JSON.stringify(Services.ppmm.sharedData.get(key) ?? []) ===
      JSON.stringify(expected),
    `Waiting for ${JSON.stringify(expected)} to be turned off`
  );
}

async function addTab(win, url = PAGE) {
  const tab = BrowserTestUtils.addTab(win.gBrowser, url, {
    skipAnimation: true,
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  return tab;
}

async function closeWindow(win, tabsBefore) {
  await BrowserTestUtils.closeWindow(win);
  // Closing a synced window moves its tabs into this one
  for (const tab of gZenWorkspaces.allStoredTabs) {
    if (!tabsBefore.has(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  }
}

add_task(async function test_Content_Scripts_Respect_Space() {
  const extensions = await loadMarkerExtensions();
  const { extA, extB } = extensions;
  const firstSpace = gZenWorkspaces.activeWorkspace;
  const secondSpace = await addSpace("Space Extensions");
  await setDisabledExtensions(firstSpace, [extA.id]);
  await setDisabledExtensions(secondSpace, [extB.id]);

  const tab = await addTab(window);
  Assert.equal(tab.getAttribute("zen-workspace-id"), firstSpace);
  Assert.deepEqual(
    await getMarkers(tab),
    { a: false, b: true },
    "Only the extension allowed in the first space ran"
  );

  gZenWorkspaces.moveTabToWorkspace(tab, secondSpace);
  await waitForDisabled(tab, [extB.id]);
  await BrowserTestUtils.reloadTab(tab);
  Assert.deepEqual(
    await getMarkers(tab),
    { a: true, b: false },
    "After moving spaces, only the extension allowed there ran"
  );

  await setDisabledExtensions(secondSpace, []);
  await waitForDisabled(tab, []);
  await BrowserTestUtils.reloadTab(tab);
  Assert.deepEqual(
    await getMarkers(tab),
    { a: true, b: true },
    "Allowing an extension again lets it run"
  );

  BrowserTestUtils.removeTab(tab);
  await resetSpace(firstSpace);
  await gZenWorkspaces.removeWorkspace(secondSpace);
  await unloadAll(extensions);
});

add_task(async function test_Essentials_Follow_Active_Space() {
  const extensions = await loadMarkerExtensions();
  const { extA } = extensions;
  const firstSpace = gZenWorkspaces.activeWorkspace;
  const secondSpace = await addSpace("Space Essentials");
  await setDisabledExtensions(firstSpace, [extA.id]);

  const tab = await addTab(window);
  gZenPinnedTabManager.addToEssentials(tab);
  ok(!tab.hasAttribute("zen-workspace-id"), "Essentials have no space");
  await waitForDisabled(tab, [extA.id]);
  await BrowserTestUtils.reloadTab(tab);
  Assert.deepEqual(await getMarkers(tab), { a: false, b: true });

  await gZenWorkspaces.changeWorkspaceWithID(secondSpace);
  await waitForDisabled(tab, []);
  await BrowserTestUtils.reloadTab(tab);
  Assert.deepEqual(
    await getMarkers(tab),
    { a: true, b: true },
    "The essential follows the newly active space"
  );

  await gZenWorkspaces.changeWorkspaceWithID(firstSpace);
  BrowserTestUtils.removeTab(tab);
  await resetSpace(firstSpace);
  await gZenWorkspaces.removeWorkspace(secondSpace);
  await unloadAll(extensions);
});

add_task(async function test_Changes_Apply_To_Other_Windows() {
  const extensions = await loadMarkerExtensions();
  const tabsBefore = new Set(gZenWorkspaces.allStoredTabs);
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await win.gZenWorkspaces.promiseInitialized;
  const spaceId = win.gZenWorkspaces.activeWorkspace;
  ok(gZenWorkspaces.getWorkspaceFromId(spaceId), "Windows share spaces");

  const tab = await addTab(win);
  Assert.deepEqual(await getMarkers(tab), { a: true, b: true });

  // Changed from the first window, applied to a tab in the second one.
  await setDisabledExtensions(spaceId, [extensions.extA.id]);
  await waitForDisabled(tab, [extensions.extA.id]);
  await BrowserTestUtils.reloadTab(tab);
  Assert.deepEqual(
    await getMarkers(tab),
    { a: false, b: true },
    "The other window picked up the change"
  );

  await resetSpace(spaceId);
  await closeWindow(win, tabsBefore);
  await unloadAll(extensions);
});

add_task(async function test_New_Window_First_Load() {
  const extensions = await loadMarkerExtensions();
  const spaceIds = gZenWorkspaces.getWorkspaces().map(space => space.uuid);
  for (const spaceId of spaceIds) {
    await setDisabledExtensions(spaceId, [extensions.extA.id]);
  }

  const tabsBefore = new Set(gZenWorkspaces.allStoredTabs);
  const newWindow = BrowserTestUtils.waitForNewWindow({ url: PAGE });
  openDialog(AppConstants.BROWSER_CHROME_URL, "", "chrome,all,dialog=no", PAGE);
  const win = await newWindow;
  const tab = win.gZenWorkspaces.allStoredTabs.find(
    t => t.linkedBrowser.currentURI.spec === PAGE
  );
  Assert.deepEqual(
    await getMarkers(tab),
    { a: false, b: true },
    "The first page of a new window already respects its space"
  );

  for (const spaceId of spaceIds) {
    await resetSpace(spaceId);
  }
  await closeWindow(win, tabsBefore);
  await unloadAll(extensions);
});

function countPublishedTabs() {
  return [...Services.ppmm.sharedData.keys()].filter(key =>
    key.startsWith("zen-space-disabled-extensions:")
  ).length;
}

add_task(async function test_Closed_Tabs_And_Windows_Are_Forgotten() {
  const extensions = await loadMarkerExtensions();
  const spaceId = gZenWorkspaces.activeWorkspace;
  await setDisabledExtensions(spaceId, [extensions.extA.id]);
  const before = countPublishedTabs();

  const tab = await addTab(window);
  Assert.equal(countPublishedTabs(), before + 1, "The new tab is published");
  BrowserTestUtils.removeTab(tab);
  Assert.equal(countPublishedTabs(), before, "And forgotten once closed");

  const tabsBefore = new Set(gZenWorkspaces.allStoredTabs);
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await win.gZenWorkspaces.promiseInitialized;
  await addTab(win);
  Assert.greater(countPublishedTabs(), before, "The window is published");
  await closeWindow(win, tabsBefore);
  Assert.equal(countPublishedTabs(), before, "And forgotten once closed");

  await resetSpace(spaceId);
  Assert.equal(countPublishedTabs(), 0, "Nothing is left behind");
  await unloadAll(extensions);
});

add_task(async function test_Essential_Shown_In_Another_Window() {
  const extensions = await loadMarkerExtensions();
  const { extA } = extensions;
  const firstSpace = gZenWorkspaces.activeWorkspace;
  const secondSpace = await addSpace("Space Other Window");
  await setDisabledExtensions(firstSpace, [extA.id]);

  const tabsBefore = new Set(gZenWorkspaces.allStoredTabs);
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await win.gZenWorkspaces.promiseInitialized;
  await win.gZenWorkspaces.changeWorkspaceWithID(secondSpace);

  const tab = await addTab(window);
  gZenPinnedTabManager.addToEssentials(tab);
  await waitForDisabled(tab, [extA.id]);
  const otherTab = await TestUtils.waitForCondition(
    () => gZenWindowSync.getItemFromWindow(win, tab.id),
    "Waiting for the essential to show up in the other window"
  );

  // Window sync hands the page over to the window showing the essential
  await SimpleTest.promiseFocus(win);
  win.gBrowser.selectedTab = otherTab;
  await TestUtils.waitForCondition(
    () => otherTab.linkedBrowser.currentURI.spec === PAGE,
    "Waiting for the other window to take over the page"
  );
  await waitForDisabled(otherTab, []);
  await BrowserTestUtils.reloadTab(otherTab);
  Assert.deepEqual(
    await getMarkers(otherTab),
    { a: true, b: true },
    "The essential follows the space of the window showing it"
  );

  BrowserTestUtils.removeTab(tab);
  await resetSpace(firstSpace);
  await closeWindow(win, tabsBefore);
  await gZenWorkspaces.removeWorkspace(secondSpace);
  await unloadAll(extensions);
});

add_task(async function test_Execute_Script_Reports_Error() {
  const ext = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id: "execute@zen-test" } },
      permissions: ["https://example.com/*"],
    },
    background() {
      browser.test.onMessage.addListener(async () => {
        const [tab] = await browser.tabs.query({
          url: "https://example.com/*",
        });
        try {
          await browser.tabs.executeScript(tab.id, { code: "1" });
          browser.test.sendMessage("result", "ran");
        } catch (e) {
          browser.test.sendMessage("result", e.message);
        }
      });
    },
    useAddonManager: "temporary",
  });
  await ext.startup();
  const spaceId = gZenWorkspaces.activeWorkspace;

  const tab = await addTab(window);
  ext.sendMessage("execute");
  Assert.equal(await ext.awaitMessage("result"), "ran");

  await setDisabledExtensions(spaceId, [ext.id]);
  await waitForDisabled(tab, [ext.id]);
  ext.sendMessage("execute");
  Assert.equal(
    await ext.awaitMessage("result"),
    "The extension isn't allowed on pages in this Space",
    "The extension learns why its script didn't run"
  );

  BrowserTestUtils.removeTab(tab);
  await resetSpace(spaceId);
  await ext.unload();
});

async function loadButtonExtension() {
  const ext = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id: "button@zen-test" } },
      browser_action: { default_area: "navbar" },
    },
    useAddonManager: "temporary",
  });
  await ext.startup();
  return ext;
}

function isButtonShown(win, ext) {
  const button = win.document.querySelector(
    `.unified-extensions-item[data-extensionid="${ext.id}"]`
  );
  return !!button && win.getComputedStyle(button).display !== "none";
}

add_task(async function test_Toolbar_Button_Follows_Space() {
  const ext = await loadButtonExtension();
  const isShown = () => isButtonShown(window, ext);
  ok(isShown(), "The button shows by default");

  const firstSpace = gZenWorkspaces.activeWorkspace;
  const secondSpace = await addSpace("Space Buttons");
  await setDisabledExtensions(firstSpace, [ext.id]);
  ok(!isShown(), "Hidden in this space");

  await gZenWorkspaces.changeWorkspaceWithID(secondSpace);
  ok(isShown(), "Shown in the other space");

  await gZenWorkspaces.changeWorkspaceWithID(firstSpace);
  ok(!isShown(), "Hidden again");

  await resetSpace(firstSpace);
  ok(isShown(), "Shown after allowing it again");
  await gZenWorkspaces.removeWorkspace(secondSpace);
  await ext.unload();
});

add_task(async function test_Toolbar_With_Two_Windows_On_One_Space() {
  const ext = await loadButtonExtension();
  const firstSpace = gZenWorkspaces.activeWorkspace;
  const secondSpace = await addSpace("Space Two Windows");
  await setDisabledExtensions(firstSpace, [ext.id]);
  ok(!isButtonShown(window, ext));

  const tabsBefore = new Set(gZenWorkspaces.allStoredTabs);
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await win.gZenWorkspaces.promiseInitialized;
  await win.gZenWorkspaces.changeWorkspaceWithID(secondSpace);
  ok(isButtonShown(win, ext));

  // The other window already made the second space the last active one
  await gZenWorkspaces.changeWorkspaceWithID(secondSpace);
  ok(
    isButtonShown(window, ext),
    "This window shows the button after switching too"
  );

  await gZenWorkspaces.changeWorkspaceWithID(firstSpace);
  await resetSpace(firstSpace);
  await closeWindow(win, tabsBefore);
  await gZenWorkspaces.removeWorkspace(secondSpace);
  await ext.unload();
});

add_task(async function test_Extensions_Menu() {
  const ext = await loadMarkerExtension("menuext");
  const activeSpace = gZenWorkspaces.activeWorkspace;
  const otherSpace = await addSpace("Space Menu");
  const popup = document.getElementById(
    "context_zenWorkspaceExtensions"
  ).menupopup;
  const findItem = () =>
    Array.from(popup.children).find(
      child => child.getAttribute("label") === "menuext"
    );
  // What the menu does when a checkbox is clicked
  const clickItem = () => {
    findItem().toggleAttribute("checked");
    findItem().doCommand();
  };

  // The menu edits the space that was right-clicked, not the active one
  await gZenSpaceExtensions.populateMenu(popup, otherSpace);
  ok(findItem().hasAttribute("checked"), "Extensions are allowed by default");
  clickItem();
  Assert.deepEqual(
    gZenWorkspaces.getWorkspaceFromId(otherSpace).disabledExtensions,
    [ext.id],
    "Unchecking turns it off in that space"
  );
  ok(
    !gZenWorkspaces.getWorkspaceFromId(activeSpace).disabledExtensions,
    "The active space is left alone"
  );

  await gZenSpaceExtensions.populateMenu(popup, otherSpace);
  ok(!findItem().hasAttribute("checked"), "Reopening shows it turned off");
  clickItem();
  Assert.deepEqual(
    gZenWorkspaces.getWorkspaceFromId(otherSpace).disabledExtensions,
    [],
    "Checking allows it again"
  );

  popup.replaceChildren();
  await gZenWorkspaces.removeWorkspace(otherSpace);
  await ext.unload();
});
