/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const EXTENSION_ID = "synced@zen-test";

function disabledExtensions(uuid) {
  return gZenWorkspaces.getWorkspaceFromId(uuid).disabledExtensions;
}

async function applySpace(uuid, data) {
  const failed = await ZenSpacesSyncApplier.applyBatch([
    { id: uuid, deleted: false, cleartext: { kind: "space", data } },
  ]);
  Assert.deepEqual(failed, [], "the space record applies cleanly");
}

add_task(async function test_DisabledExtensionsProject() {
  await gZenWorkspaces.promiseInitialized;
  const uuid = gZenWorkspaces.activeWorkspace;

  let spaceData = (await collectProjections()).get(uuid).data;
  Assert.ok(
    !("disabledExtensions" in spaceData),
    "spaces that never changed their extensions don't carry the field"
  );

  const space = gZenWorkspaces.getWorkspaceFromId(uuid);
  await gZenWorkspaces.saveWorkspace({
    ...space,
    disabledExtensions: [EXTENSION_ID],
  });
  spaceData = (await collectProjections()).get(uuid).data;
  Assert.deepEqual(spaceData.disabledExtensions, [EXTENSION_ID]);

  const { disabledExtensions: _, ...rest } = space;
  await gZenWorkspaces.saveWorkspace(rest);
});

add_task(async function test_DisabledExtensionsApply() {
  await gZenWorkspaces.promiseInitialized;
  const uuid = gZenWorkspaces.activeWorkspace;
  const spaceData = (await collectProjections()).get(uuid).data;

  await applySpace(uuid, {
    ...spaceData,
    disabledExtensions: [EXTENSION_ID],
  });
  Assert.deepEqual(
    disabledExtensions(uuid),
    [EXTENSION_ID],
    "the remote setting is applied"
  );
  const key = `zen-space-disabled-extensions:${gBrowser.selectedBrowser.browserId}`;
  Assert.deepEqual(
    Services.ppmm.sharedData.get(key),
    [EXTENSION_ID],
    "and reaches the tabs that are open"
  );

  const { disabledExtensions: _, ...olderRecord } = spaceData;
  await applySpace(uuid, { ...olderRecord, name: "Renamed remotely" });
  Assert.equal(
    gZenWorkspaces.getWorkspaceFromId(uuid).name,
    "Renamed remotely"
  );
  Assert.deepEqual(
    disabledExtensions(uuid),
    [EXTENSION_ID],
    "records from older versions keep the local setting"
  );

  await applySpace(uuid, { ...spaceData, disabledExtensions: [] });
  Assert.deepEqual(disabledExtensions(uuid), [], "clearing it applies too");

  ZenSpacesSyncModel.noteApplied(uuid, null);
  const { disabledExtensions: _unused, ...space } =
    gZenWorkspaces.getWorkspaceFromId(uuid);
  await gZenWorkspaces.saveWorkspace(space);
});
