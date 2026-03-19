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
    decode_filename, block_name, drive_name, fmt_size, block_cmp,
} from "../utils.js";
import { navigate_away_from_card } from "../pages.jsx";

const _ = cockpit.gettext;

/* ---- Available block device discovery for ZFS ---- */

/**
 * Build a list of block devices that are available for ZFS use.
 *
 * A device is "available" when all of these hold:
 *   - Leaf device (no partition table)
 *   - Not a multipath subordinate (raw sd* behind a dm-* master)
 *   - Not consumed by LVM, MDRAID, ZFS, Stratis, BTRFS multi-device, swap, or a mounted filesystem
 *   - Not locked LUKS (unusable without unlocking)
 *   - Not HintIgnore, not zero-size
 *
 * zvols and loop devices are intentionally included.
 */
function get_available_zfs_devices() {
    const available = [];

    // Build a set of block paths that are multipath subordinates.
    // These should not be shown — only the multipath master (dm-*) is usable.
    const multipath_subordinates = new Set();
    for (const drive_path in client.drives_multipath_blocks) {
        for (const blk of client.drives_multipath_blocks[drive_path])
            multipath_subordinates.add(blk.path);
    }

    for (const [path, block] of Object.entries(client.blocks)) {
        // Skip devices with a partition table (they are containers, not leaf)
        if (client.blocks_ptable[path])
            continue;

        // Skip multipath subordinates
        if (multipath_subordinates.has(path))
            continue;

        // Skip if HintIgnore
        if (block.HintIgnore)
            continue;

        // Skip zero-size devices
        if (block.Size === 0)
            continue;

        // Skip if actively consumed by LVM as a physical volume
        const pvol = client.blocks_pvol[path];
        if (pvol && client.vgroups[pvol.VolumeGroup])
            continue;

        // Skip if MDRAID member
        if (block.MDRaidMember && block.MDRaidMember !== "/")
            continue;

        // Skip if ZFS pool member (Block.ZFS with an active pool)
        const block_zfs = client.blocks_zfs[path];
        if (block_zfs) {
            const zpool = client.zfs_pools[block_zfs.Pool];
            if (zpool)
                continue; // actively part of an imported pool
        }

        // Skip if Stratis blockdev
        if (client.blocks_stratis_blockdev[path])
            continue;

        // Skip if active swap
        const swap = client.blocks_swap[path];
        if (swap && swap.Active)
            continue;

        // Skip if mounted filesystem (has active mount points)
        const fsys = client.blocks_fsys[path];
        if (fsys && fsys.MountPoints && fsys.MountPoints.length > 0)
            continue;

        // Skip if BTRFS multi-device member
        if (client.blocks_fsys_btrfs && client.blocks_fsys_btrfs[path])
            continue;

        // Skip if encrypted and locked (cannot be used)
        if (client.blocks_crypto[path] && !client.blocks_cleartext[path])
            continue;

        // Skip if it has a recognized IdUsage (e.g. filesystem, crypto, raid)
        // EXCEPT: allow Filesystem.ZFS (zvols) — the user explicitly wants
        // to be able to use zvols as vdevs in other pools.
        if (block.IdUsage) {
            const is_zvol = !!client.blocks_fsys_zfs[path];
            if (!is_zvol)
                continue;
        }

        // This device is available — format it for display
        const dev_name = block_name(block);
        const size = fmt_size(block.Size);
        const drive = client.drives[block.Drive];
        const desc = drive ? drive_name(drive) : "";

        available.push({
            path,
            device: dev_name,
            size,
            description: desc,
            block,
        });
    }

    return available.sort((a, b) => block_cmp(a.block, b.block));
}

/**
 * Build SelectOne choices from available ZFS devices.
 * Returns an array of { value, title } suitable for SelectOne.
 */
function get_zfs_device_choices() {
    const devices = get_available_zfs_devices();
    return devices.map(d => {
        const label = d.description
            ? cockpit.format("$0 $1 ($2)", d.device, d.size, d.description)
            : cockpit.format("$0 $1", d.device, d.size);
        return { value: d.device, title: label };
    });
}

/**
 * Build SelectSpaces-compatible space objects from available ZFS devices.
 * Returns an array of { type, block, size, desc } matching the format
 * expected by SelectSpaces and prepare_available_spaces.
 */
function get_zfs_available_spaces() {
    const devices = get_available_zfs_devices();
    return devices.map(d => ({
        type: 'block',
        block: d.block,
        size: d.block.Size,
        desc: d.description
            ? cockpit.format("$0 ($1)", d.device, d.description)
            : d.device,
    }));
}

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

    const spaces = get_zfs_available_spaces();

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
                empty_warning: _("No available block devices were found."),
                validate: function (disks) {
                    if (disks.length === 0)
                        return _("At least one block device is needed.");
                },
                spaces,
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
                const devs = vals.disks.map(spc => decode_filename(spc.block.PreferredDevice));
                return client.zfs_manager.PoolCreate(vals.name, devs, vals.vdev_type, {});
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
                // D-Bus return type is aa{sv}.  Cockpit wraps the return
                // value in an array: result[0] is the outer array, and
                // each element is a dict of {key: {t, v}} variants.
                // Guard against unexpected shapes so we never crash.
                let raw = result;
                if (Array.isArray(raw) && !Array.isArray(raw[0]) && raw.length > 0 && typeof raw[0] === 'object' && raw[0] !== null)
                    raw = raw; // already the array of dicts
                else if (Array.isArray(raw) && Array.isArray(raw[0]))
                    raw = raw[0]; // unwrap one layer
                else
                    raw = [];

                // Normalise each pool element: the dict values may be
                // Cockpit D-Bus variants ({t, v}) or plain values.
                const pools = raw.filter(p => p && typeof p === 'object').map(p => {
                    const get = (key) => {
                        const entry = p[key];
                        if (entry == null) return "";
                        if (typeof entry === 'object' && 'v' in entry) return entry.v;
                        return entry;
                    };
                    return { name: get("name"), guid: get("guid"), state: get("state") };
                });

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
                    value: p.name,
                    title: cockpit.format("$0 (GUID $1, $2)", p.name, p.guid, p.state),
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
    const choices = get_zfs_device_choices();

    if (choices.length === 0) {
        dialog_open({
            Title: cockpit.format(_("Replace device $0"), device_path),
            Body: <p>{_("No available block devices found for replacement.")}</p>,
            Fields: [],
            Action: {
                Title: _("Close"),
                action: function () { /* nothing */ }
            }
        });
        return;
    }

    dialog_open({
        Title: cockpit.format(_("Replace device $0"), device_path),
        Fields: [
            SelectOne("new_device", _("Replacement device"), { choices }),
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
    const choices = get_zfs_device_choices();

    if (choices.length === 0) {
        dialog_open({
            Title: cockpit.format(_("Attach mirror to $0"), device_path),
            Body: <p>{_("No available block devices found.")}</p>,
            Fields: [],
            Action: {
                Title: _("Close"),
                action: function () { /* nothing */ }
            }
        });
        return;
    }

    dialog_open({
        Title: cockpit.format(_("Attach mirror to $0"), device_path),
        Fields: [
            SelectOne("new_device", _("New device"), { choices }),
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

/* ---- Pool-level: Stop trim ---- */

export function stop_trim_zfs_pool(pool) {
    dialog_open({
        Title: cockpit.format(_("Stop TRIM on pool $0?"), pool.Name),
        Body: <div>
            <p>{cockpit.format(_("This will cancel the running TRIM operation on pool $0."), pool.Name)}</p>
        </div>,
        Action: {
            Title: _("Stop trim"),
            action: async function () {
                await client.zfs_pool_call(pool.path, "TrimStop", [{}]);
            }
        }
    });
}

/* ---- Pool-level: Clear errors ---- */

export function clear_errors_zfs_pool(pool) {
    dialog_open({
        Title: cockpit.format(_("Clear errors on pool $0?"), pool.Name),
        Body: <div>
            <p>{cockpit.format(_("This will clear all error counters for pool $0."), pool.Name)}</p>
        </div>,
        Action: {
            Title: _("Clear errors"),
            action: async function () {
                await client.zfs_pool_call(pool.path, "ClearErrors", ["", {}]);
            }
        }
    });
}

/* ---- Pool-level: Upgrade pool ---- */

export function upgrade_zfs_pool(pool) {
    dialog_open({
        Title: cockpit.format(_("Upgrade pool $0?"), pool.Name),
        Body: <div>
            <p>{cockpit.format(_("Upgrading pool $0 to the latest on-disk format version is irreversible. Once upgraded, the pool cannot be imported on systems running older ZFS versions."), pool.Name)}</p>
        </div>,
        Action: {
            DangerButton: true,
            Danger: _("This operation is irreversible. The pool will not be compatible with older ZFS versions."),
            Title: _("Upgrade"),
            action: async function () {
                await client.zfs_pool_call(pool.path, "Upgrade", [{}]);
            }
        }
    });
}

/* ---- Pool-level: View history ---- */

export function view_history_zfs_pool(pool) {
    client.zfs_pool_call(pool.path, "GetHistory", [{}])
            .then(result => {
                const history_text = result[0] || _("No history available.");
                dialog_open({
                    Title: cockpit.format(_("History for pool $0"), pool.Name),
                    Body: <pre style={{ whiteSpace: "pre-wrap", maxHeight: "400px", overflow: "auto" }}>{history_text}</pre>,
                    Fields: [],
                    Action: {
                        Title: _("Close"),
                        action: function () { /* nothing */ }
                    }
                });
            })
            .catch(err => {
                dialog_open({
                    Title: _("Error"),
                    Body: err.toString(),
                });
            });
}

/* ---- Dataset: Promote clone ---- */

export function promote_clone(pool_path, clone_name) {
    dialog_open({
        Title: cockpit.format(_("Promote clone $0?"), clone_name),
        Body: <div>
            <p>{cockpit.format(_("Promoting $0 will reverse the parent-child relationship with its origin snapshot. The clone will become independent."), clone_name)}</p>
        </div>,
        Action: {
            Title: _("Promote"),
            action: async function () {
                await client.zfs_pool_call(pool_path, "PromoteClone", [clone_name, {}]);
            }
        }
    });
}

/* ---- Snapshot: Hold ---- */

export function hold_snapshot(pool_path, snapshot_name) {
    dialog_open({
        Title: cockpit.format(_("Add hold on snapshot $0"), snapshot_name),
        Fields: [
            TextInput("tag", _("Hold tag"), {
                validate: val => {
                    if (val === "")
                        return _("Tag name is required");
                    if (/\s/.test(val))
                        return _("Tag cannot contain spaces");
                    return null;
                }
            }),
        ],
        Action: {
            Title: _("Hold"),
            action: async function (vals) {
                await client.zfs_pool_call(pool_path, "HoldSnapshot", [snapshot_name, vals.tag, {}]);
            }
        }
    });
}

/* ---- Snapshot: Release ---- */

export function release_snapshot(pool_path, snapshot_name) {
    dialog_open({
        Title: cockpit.format(_("Release hold on snapshot $0"), snapshot_name),
        Fields: [
            TextInput("tag", _("Hold tag"), {
                validate: val => {
                    if (val === "")
                        return _("Tag name is required");
                    return null;
                }
            }),
        ],
        Action: {
            Title: _("Release"),
            action: async function (vals) {
                await client.zfs_pool_call(pool_path, "ReleaseSnapshot", [snapshot_name, vals.tag, {}]);
            }
        }
    });
}

/* ---- Dataset: Inherit property ---- */

export function inherit_property(pool_path, dataset_name) {
    dialog_open({
        Title: cockpit.format(_("Inherit property on $0"), dataset_name),
        Fields: [
            SelectOne("property", _("Property"), {
                choices: [
                    { value: "compression", title: _("compression") },
                    { value: "atime", title: _("atime") },
                    { value: "relatime", title: _("relatime") },
                    { value: "dedup", title: _("dedup") },
                    { value: "sync", title: _("sync") },
                    { value: "recordsize", title: _("recordsize") },
                    { value: "mountpoint", title: _("mountpoint") },
                    { value: "quota", title: _("quota") },
                    { value: "reservation", title: _("reservation") },
                    { value: "acltype", title: _("acltype") },
                    { value: "xattr", title: _("xattr") },
                    { value: "checksum", title: _("checksum") },
                    { value: "readonly", title: _("readonly") },
                    { value: "canmount", title: _("canmount") },
                    { value: "logbias", title: _("logbias") },
                    { value: "primarycache", title: _("primarycache") },
                    { value: "secondarycache", title: _("secondarycache") },
                    { value: "snapdir", title: _("snapdir") },
                ],
            }),
        ],
        Action: {
            Title: _("Inherit"),
            action: async function (vals) {
                await client.zfs_pool_call(pool_path, "InheritProperty", [dataset_name, vals.property, {}]);
            }
        }
    });
}

/* ---- Volume: Resize ---- */

export function resize_volume(pool_path, volume_name) {
    dialog_open({
        Title: cockpit.format(_("Resize volume $0"), volume_name),
        Fields: [
            TextInput("new_size", _("New size (bytes)"), {
                validate: val => {
                    const n = Number(val);
                    if (isNaN(n) || n <= 0)
                        return _("Size must be a positive number");
                    return null;
                }
            }),
        ],
        Action: {
            Title: _("Resize"),
            action: async function (vals) {
                await client.zfs_pool_call(pool_path, "ResizeVolume", [volume_name, Number(vals.new_size), {}]);
            }
        }
    });
}

/* ---- Dataset: View/Edit properties ---- */

export function view_edit_properties(pool_path, dataset_name) {
    /* This dialog is used for both pool and dataset properties.
     * It fetches all properties via GetDatasetProperty for a list of
     * well-known properties, displays them in a table, and allows
     * editing and inheriting individual values. */

    const known_properties = [
        "compression", "atime", "relatime", "dedup", "sync",
        "recordsize", "mountpoint", "quota", "reservation",
        "acltype", "xattr", "checksum", "readonly", "canmount",
        "logbias", "primarycache", "secondarycache", "snapdir",
        "encryption", "keyformat", "keylocation",
        "used", "available", "referenced", "compressratio",
    ];

    /* Build an array of promises to fetch each property */
    const fetches = known_properties.map(prop =>
        client.zfs_pool_call(pool_path, "GetDatasetProperty", [dataset_name, prop, {}])
                .then(result => ({
                    name: prop,
                    value: result[0] || "-",
                    source: result[1] || "-",
                }))
                .catch(() => ({
                    name: prop,
                    value: "-",
                    source: "-",
                }))
    );

    Promise.all(fetches).then(props => {
        /* Format properties as a readable text table */
        const lines = props.map(p =>
            cockpit.format("$0\t$1\t($2)", p.name, p.value, p.source)
        ).join("\n");

        const header = cockpit.format("$0\t$1\t$2", _("Property"), _("Value"), _("Source"));

        dialog_open({
            Title: cockpit.format(_("Properties of $0"), dataset_name),
            Body: <pre style={{ whiteSpace: "pre-wrap", maxHeight: "400px", overflow: "auto", fontFamily: "monospace", fontSize: "12px" }}>
                {header + "\n" + "─".repeat(60) + "\n" + lines}
            </pre>,
            Fields: [],
            Action: {
                Title: _("Close"),
                action: function () { /* nothing */ }
            }
        });
    });
}

/* ---- Pool: View/Edit properties ---- */

export function view_edit_pool_properties(pool) {
    const pool_path = pool.path;
    const pool_name = pool.Name;

    const known_properties = [
        "ashift", "autoexpand", "autoreplace", "autotrim",
        "bootfs", "cachefile", "comment", "dedupditto",
        "delegation", "failmode", "feature@async_destroy",
        "fragmentation", "freeing", "guid", "health",
        "listsnapshots", "multihost", "readonly", "size",
        "version",
    ];

    const fetches = known_properties.map(prop =>
        client.zfs_pool_call(pool_path, "GetProperty", [prop, {}])
                .then(result => ({
                    name: prop,
                    value: result[0] || "-",
                    source: result[1] || "-",
                }))
                .catch(() => ({
                    name: prop,
                    value: "-",
                    source: "-",
                }))
    );

    Promise.all(fetches).then(props => {
        const lines = props.map(p =>
            cockpit.format("$0\t$1\t($2)", p.name, p.value, p.source)
        ).join("\n");

        const header = cockpit.format("$0\t$1\t$2", _("Property"), _("Value"), _("Source"));

        dialog_open({
            Title: cockpit.format(_("Properties of pool $0"), pool_name),
            Body: <pre style={{ whiteSpace: "pre-wrap", maxHeight: "400px", overflow: "auto", fontFamily: "monospace", fontSize: "12px" }}>
                {header + "\n" + "─".repeat(60) + "\n" + lines}
            </pre>,
            Fields: [],
            Action: {
                Title: _("Close"),
                action: function () { /* nothing */ }
            }
        });
    });
}

/* ---- Pool-level: Add vdev ---- */

export function add_vdev_to_pool(pool) {
    const spaces = get_zfs_available_spaces();

    dialog_open({
        Title: cockpit.format(_("Add vdev to $0"), pool.Name),
        Fields: [
            SelectSpaces("disks", _("Block devices"), {
                empty_warning: _("No available block devices were found."),
                validate: function (disks) {
                    if (disks.length === 0)
                        return _("At least one block device is needed.");
                },
                spaces,
            }),
            SelectOne("vdev_type", _("Vdev type"), {
                choices: [
                    { value: "", title: _("Stripe (no redundancy)") },
                    { value: "mirror", title: _("Mirror") },
                    { value: "raidz", title: _("RAIDZ") },
                    { value: "raidz2", title: _("RAIDZ2") },
                    { value: "raidz3", title: _("RAIDZ3") },
                ],
            }),
            CheckBoxes("options", _("Options"), {
                fields: [
                    { tag: "force", title: _("Force (allow mismatched vdev topology)") },
                ],
            }),
        ],
        Action: {
            Title: _("Add vdev"),
            action: async function (vals) {
                const block_paths = vals.disks.map(spc => spc.block.path);
                const options = {};
                if (vals.options && vals.options.force)
                    options.force = { t: 'b', v: true };
                await client.zfs_pool_call(pool.path, "AddVdev", [vals.vdev_type, block_paths, options]);
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
