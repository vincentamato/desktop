/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PAGE = "https://example.com/";

function loadMarkerExtension(name) {
  return ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id: `${name}@zen-test` } },
      content_scripts: [{ matches: [`${PAGE}*`], js: ["cs.js"] }],
    },
    files: {
      "cs.js": `document.documentElement.setAttribute("data-${name}", "");`,
    },
    useAddonManager: "temporary",
  });
}

async function setDisabledExtensions(disabledExtensions) {
  const { disabledExtensions: _, ...space } =
    gZenWorkspaces.getActiveWorkspaceFromCache();
  gZenWorkspaces.saveWorkspace(
    disabledExtensions ? { ...space, disabledExtensions } : space
  );
  // Windows pick up space changes asynchronously
  await TestUtils.waitForTick();
}

// The sentinel is never turned off, so once it marked the page the other
// content script would have run too.
function getMarkers(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    const root = content.document.documentElement;
    await ContentTaskUtils.waitForCondition(() =>
      root.hasAttribute("data-sentinel")
    );
    return root.hasAttribute("data-marker");
  });
}

add_task(async function test_little_window_follows_last_active_space() {
  const marker = loadMarkerExtension("marker");
  const sentinel = loadMarkerExtension("sentinel");
  await marker.startup();
  await sentinel.startup();

  let win = await openLittleWindowWithPage({ url: PAGE });
  ok(
    await getMarkers(win.gBrowser.selectedBrowser),
    "The extension runs in a little window"
  );
  await BrowserTestUtils.closeWindow(win);

  await setDisabledExtensions([marker.id]);
  win = await openLittleWindowWithPage({ url: PAGE });
  ok(
    !(await getMarkers(win.gBrowser.selectedBrowser)),
    "It doesn't once the last active space turns it off"
  );

  const closed = BrowserTestUtils.windowClosed(win);
  await win.gZenLittleWindow.openInSpace();
  await closed;
  const tab = gBrowser.selectedTab;
  Assert.deepEqual(
    Services.ppmm.sharedData.get(
      `zen-space-disabled-extensions:${tab.linkedBrowser.browserId}`
    ),
    [marker.id],
    "It stays off once the page is moved to that space"
  );
  await BrowserTestUtils.reloadTab(tab);
  ok(!(await getMarkers(tab.linkedBrowser)), "Also after a reload");

  BrowserTestUtils.removeTab(tab);
  await setDisabledExtensions(null);
  is(
    [...Services.ppmm.sharedData.keys()].filter(key =>
      key.startsWith("zen-space-disabled-extensions:")
    ).length,
    0,
    "Nothing is left behind"
  );
  await marker.unload();
  await sentinel.unload();
});
