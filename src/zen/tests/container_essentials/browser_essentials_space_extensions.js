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

async function setDisabledExtensions(spaceId, disabledExtensions) {
  const space = gZenWorkspaces.getWorkspaceFromId(spaceId);
  gZenWorkspaces.saveWorkspace({ ...space, disabledExtensions });
  // Windows pick up space changes asynchronously
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

async function addTab() {
  const tab = BrowserTestUtils.addTab(gBrowser, PAGE, { skipAnimation: true });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  return tab;
}

// The sentinel is never turned off, so once it marked the page the other
// content script would have run too.
function getMarkers(tab) {
  return SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const root = content.document.documentElement;
    await ContentTaskUtils.waitForCondition(() =>
      root.hasAttribute("data-sentinel")
    );
    return root.hasAttribute("data-marker");
  });
}

add_task(async function test_Essentials_Keep_Space_While_Not_Shown() {
  const marker = loadMarkerExtension("marker");
  const sentinel = loadMarkerExtension("sentinel");
  await marker.startup();
  await sentinel.startup();
  const firstSpace = gZenWorkspaces.activeWorkspace;
  // Essentials are only shown in spaces sharing their container
  const secondSpace = (
    await gZenWorkspaces.createAndSaveWorkspace("Space Container", "", true, 1)
  ).uuid;
  await setDisabledExtensions(firstSpace, [marker.id]);

  const essential = await addTab();
  gZenPinnedTabManager.addToEssentials(essential);
  await waitForDisabled(essential, [marker.id]);

  await gZenWorkspaces.changeWorkspaceWithID(secondSpace);
  const tab = await addTab();
  ok(await getMarkers(tab), "The extension runs in the second space");
  await BrowserTestUtils.reloadTab(essential);
  ok(
    !(await getMarkers(essential)),
    "The essential keeps the space that shows it"
  );

  BrowserTestUtils.removeTab(tab);
  await gZenWorkspaces.changeWorkspaceWithID(firstSpace);
  BrowserTestUtils.removeTab(essential);
  const { disabledExtensions: _, ...space } =
    gZenWorkspaces.getWorkspaceFromId(firstSpace);
  gZenWorkspaces.saveWorkspace(space);
  await gZenWorkspaces.removeWorkspace(secondSpace);
  await marker.unload();
  await sentinel.unload();
});
