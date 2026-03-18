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

function import_zfs_pool_with_text_fallback() {
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

export function import_zfs_pool() {
    client.zfs_manager.ListImportablePools({})
            .then(result => {
                const pools = result[0] || [];
                if (pools.length === 0) {
                    dialog_open({
                        Title: _("Import ZFS pool"),
                        Body: <p>{_("No importable ZFS pools were found.")}</p>,
                        Fields: [],
                        Action: {
                            Title: _("Close"),
                            action: function () { /* nothing to do */ }
                        }
                    });
                    return;
                }

                const choices = pools.map(p => ({
                    value: p.name.v,
                    title: cockpit.format("$0 (GUID $1, $2)", p.name.v, p.guid.v, p.state.v),
                }));

                dialog_open({
                    Title: _("Import ZFS pool"),
                    Fields: [
                        SelectOne("pool", _("Pool"), { choices }),
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
                            if (vals.options && vals.options.force)
                                options.force = { t: 'b', v: true };
                            await client.zfs_manager.PoolImport(vals.pool, options);
                        }
                    }
                });
            })
            .catch(err => {
                console.warn("ListImportablePools failed, falling back to text input:", err);
                import_zfs_pool_with_text_fallback();
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

/* ---- Vdev operations ---- */

export function replace_zfs_vdev(pool, device_path) {
    dialog_open({
        Title: cockpit.format(_("Replace device $0"), device_path),
        Fields: [
            TextInput("new_device", _("Replacement device"), {
                validate: val => {
                    if (val === "")
                        return _("Device path is required");
                    return null;
                }
            }),
            CheckBoxes("options", _("Options"), {
                fields: [
                    { tag: "force", title: _("Force replace") },
                ],
            }),
        ],
        Action: {
            Title: _("Replace"),
            action: async function (vals) {
                const force = !!(vals.options && vals.options.force);
                await client.zfs_pool_call(pool.path, "ReplaceVdev", [device_path, vals.new_device, force, {}]);
            }
        }
    });
}

export function attach_zfs_vdev(pool, device_path) {
    dialog_open({
        Title: cockpit.format(_("Attach mirror to $0"), device_path),
        Fields: [
            TextInput("new_device", _("New device"), {
                validate: val => {
                    if (val === "")
                        return _("Device path is required");
                    return null;
                }
            }),
        ],
        Action: {
            Title: _("Attach"),
            action: async function (vals) {
                await client.zfs_pool_call(pool.path, "AttachVdev", [device_path, vals.new_device, {}]);
            }
        }
    });
}

export function detach_zfs_vdev(pool, device_path) {
    dialog_open({
        Title: cockpit.format(_("Detach device $0?"), device_path),
        Body: <div>
            <p>{cockpit.format(_("Detaching $0 will remove it from its mirror. The remaining device(s) will continue serving data."), device_path)}</p>
        </div>,
        Action: {
            Title: _("Detach"),
            action: async function () {
                await client.zfs_pool_call(pool.path, "DetachVdev", [device_path, {}]);
            }
        }
    });
}

export function online_zfs_vdev(pool, device_path) {
    dialog_open({
        Title: cockpit.format(_("Online device $0"), device_path),
        Fields: [
            CheckBoxes("options", _("Options"), {
                fields: [
                    { tag: "expand", title: _("Expand device to use all available space") },
                ],
            }),
        ],
        Action: {
            Title: _("Online"),
            action: async function (vals) {
                const expand = !!(vals.options && vals.options.expand);
                await client.zfs_pool_call(pool.path, "OnlineVdev", [device_path, expand, {}]);
            }
        }
    });
}

export function offline_zfs_vdev(pool, device_path) {
    dialog_open({
        Title: cockpit.format(_("Offline device $0?"), device_path),
        Body: <div>
            <p>{cockpit.format(_("Taking $0 offline will make it unavailable for I/O. The pool must have sufficient redundancy to remain operational."), device_path)}</p>
        </div>,
        Fields: [
            CheckBoxes("options", _("Options"), {
                fields: [
                    { tag: "temporary", title: _("Temporary (revert on reboot)") },
                ],
            }),
        ],
        Action: {
            Title: _("Offline"),
            action: async function (vals) {
                const temporary = !!(vals.options && vals.options.temporary);
                await client.zfs_pool_call(pool.path, "OfflineVdev", [device_path, temporary, {}]);
            }
        }
    });
}
