/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import cockpit from "cockpit";
import React from "react";
import client from "../client";

import {
    dialog_open, TextInput, SelectOne, SelectSpaces, PassInput, CheckBoxes,
} from "../dialog.jsx";
import {
    get_available_spaces, prepare_available_spaces, decode_filename,
} from "../utils.js";
import { navigate_away_from_card } from "../pages.jsx";

const _ = cockpit.gettext;

/* ---- Pool creation (Manager.ZFS method) ---- */

export function create_zfs_pool() {
    function find_pool(name) {
        for (const p in client.zfs_pools) {
            if (client.zfs_pools[p].Name === name)
                return client.zfs_pools[p];
        }
        return null;
    }

    let name;
    for (let i = 0; i < 1000; i++) {
        name = "zpool" + i.toFixed();
        if (!find_pool(name))
            break;
    }

    dialog_open({
        Title: _("Create ZFS pool"),
        Fields: [
            TextInput("name", _("Pool name"), {
                value: name,
                validate: val => {
                    if (val === "")
                        return _("Name is required");
                    if (/\s/.test(val))
                        return _("Name cannot contain spaces");
                    if (val.indexOf("/") >= 0)
                        return _("Name cannot contain '/'");
                    // Check for duplicate name
                    if (find_pool(val))
                        return _("A pool with this name already exists");
                    return null;
                }
            }),
            SelectSpaces("disks", _("Block devices"), {
                empty_warning: _("No block devices are available."),
                validate: function (disks) {
                    if (disks.length === 0)
                        return _("At least one block device is needed.");
                },
                spaces: get_available_spaces(),
            }),
            SelectOne("vdev_type", _("Layout"), {
                choices: [
                    { value: "", title: _("Stripe (no redundancy)") },
                    { value: "mirror", title: _("Mirror") },
                    { value: "raidz", title: _("RAIDZ") },
                    { value: "raidz2", title: _("RAIDZ2") },
                    { value: "raidz3", title: _("RAIDZ3") },
                ],
            }),
        ],
        Action: {
            Title: _("Create"),
            action: function (vals) {
                return prepare_available_spaces(client, vals.disks).then(paths => {
                    const devs = paths.map(p => decode_filename(client.blocks[p].PreferredDevice));
                    return client.zfs_manager.PoolCreate(vals.name, devs, vals.vdev_type, {});
                });
            }
        }
    });
}

/* ---- Pool import (Manager.ZFS method) ---- */

export function import_zfs_pool() {
    dialog_open({
        Title: _("Import ZFS pool"),
        Fields: [
            TextInput("name_or_guid", _("Pool name or GUID"), {
                validate: val => {
                    if (val === "")
                        return _("Name or GUID is required");
                    return null;
                }
            }),
            CheckBoxes("options", _("Options"), {
                fields: [
                    { tag: "force", title: _("Force import") },
                ],
            }),
        ],
        Action: {
            Title: _("Import"),
            action: async function (vals) {
                const options = {};
                if (vals.options && vals.options.force) {
                    options.force = { t: 'b', v: true };
                }
                await client.zfs_manager.PoolImport(vals.name_or_guid, options);
            }
        }
    });
}

/* ---- Pool export ---- */

export function export_zfs_pool(pool) {
    dialog_open({
        Title: cockpit.format(_("Export pool $0?"), pool.Name),
        Body: <div>
            <p>{cockpit.format(_("Exporting pool $0 will make it unavailable until imported again."), pool.Name)}</p>
        </div>,
        Action: {
            Title: _("Export"),
            action: async function () {
                await client.zfs_pool_call(pool.path, "Export", [false, {}]);
            }
        }
    });
}

/* ---- Pool destroy (DANGER) ---- */

export function destroy_zfs_pool(pool, card) {
    const pool_name = pool.Name;

    dialog_open({
        Title: cockpit.format(_("Permanently destroy pool $0?"), pool_name),
        Body: <div>
            <p>{cockpit.format(_("All data in pool $0 will be permanently deleted. This action cannot be undone."), pool_name)}</p>
        </div>,
        Fields: [
            TextInput("confirm", _("Confirm by typing pool name"), {
                validate: val => val !== pool_name ? _("Pool name does not match") : null
            }),
        ],
        Action: {
            DangerButton: true,
            Danger: _("Destroying a ZFS pool will permanently erase all data it contains."),
            Title: _("Destroy"),
            action: async function () {
                await client.zfs_pool_call(pool.path, "Destroy", [true, {}]);
                navigate_away_from_card(card);
            }
        }
    });
}

/* ---- Encryption key management ---- */

export function load_zfs_key(pool) {
    dialog_open({
        Title: cockpit.format(_("Load encryption key for $0"), pool.Name),
        Fields: [
            PassInput("passphrase", _("Passphrase"), {
                validate: val => {
                    if (val === "")
                        return _("Passphrase is required");
                    return null;
                }
            }),
        ],
        Action: {
            Title: _("Load key"),
            action: async function (vals) {
                // Encode passphrase as byte array for D-Bus
                const encoder = new TextEncoder();
                const bytes = Array.from(encoder.encode(vals.passphrase));
                await client.zfs_pool_call(pool.path, "LoadKey", [
                    { passphrase: { t: 'ay', v: bytes } }
                ]);
            }
        }
    });
}

export function unload_zfs_key(pool) {
    dialog_open({
        Title: cockpit.format(_("Unload encryption key for $0?"), pool.Name),
        Body: <div>
            <p>{_("Unloading the encryption key will lock encrypted datasets. They will be inaccessible until the key is loaded again.")}</p>
        </div>,
        Action: {
            Title: _("Unload key"),
            action: async function () {
                await client.zfs_pool_call(pool.path, "UnloadKey", [{}]);
            }
        }
    });
}
