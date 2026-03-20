/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import cockpit from "cockpit";
import React, { useState, useEffect, useCallback } from "react";
import client from "../client";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { CardBody } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { SearchInput } from "@patternfly/react-core/dist/esm/components/SearchInput/index.js";
import { Toolbar, ToolbarContent, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar/index.js";
import { ToggleGroup, ToggleGroupItem } from "@patternfly/react-core/dist/esm/components/ToggleGroup/index.js";
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { EmptyState, EmptyStateBody } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";

import { InputGroup, InputGroupItem, InputGroupText } from "@patternfly/react-core/dist/esm/components/InputGroup/index.js";
import { TextInput as TextInputPF } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";

import { StorageCard } from "../pages.jsx";
import { StorageBarMenu, StorageMenuItem } from "../storage-controls.jsx";
import { dialog_open, TextInput, SizeSlider, SelectOne, CheckBoxes } from "../dialog.jsx";
import { fmt_size } from "../utils.js";
import {
    promote_clone, hold_snapshot, release_snapshot,
    inherit_property, resize_volume, view_properties,
    load_key, unload_key, change_key,
} from "./dialogs.jsx";

const _ = cockpit.gettext;

/* ---- action helpers (exported for use in new_card actions) ---- */

export function create_filesystem(pool_path, pool_name) {
    // Fetch current datasets to show existing filesystems as hints
    client.zfs_pool_call(pool_path, "ListDatasets", [{ type: { t: 's', v: 'all' } }])
            .then(result => {
                const parsed = result[0].map(parse_dataset);
                const existing_filesystems = parsed
                        .filter(d => d.type === "filesystem")
                        .map(d => d.name);

                const prefix = pool_name + "/";

                dialog_open({
                    Title: cockpit.format(_("Create ZFS filesystem on $0"), pool_name),
                    Fields: [
                        {
                            tag: "name",
                            title: _("Name"),
                            options: {
                                validate: val => {
                                    if (val === "")
                                        return _("Name cannot be empty");
                                    if (val.startsWith("-"))
                                        return _("Name cannot start with '-'");
                                    if (/[\s@#]/.test(val))
                                        return _("Name cannot contain spaces, '@', or '#'");
                                    if (val.indexOf("/") >= 0)
                                        return _("Name cannot contain '/' — enter only the component name");
                                    return null;
                                },
                            },
                            initial_value: "",
                            render: (val, change, validated) => {
                                const existing_hint = existing_filesystems.length > 0
                                    ? cockpit.format(_("Existing filesystems: $0"),
                                                     existing_filesystems.join(", "))
                                    : _("No existing filesystems");

                                return (
                                    <>
                                        <InputGroup>
                                            <InputGroupText>{prefix}</InputGroupText>
                                            <InputGroupItem isFill>
                                                <TextInputPF
                                                    data-field="name"
                                                    data-field-type="text-input"
                                                    validated={validated}
                                                    aria-label={_("Name")}
                                                    value={val}
                                                    placeholder={_("myfilesystem")}
                                                    onChange={(_event, value) => change(value)} />
                                            </InputGroupItem>
                                        </InputGroup>
                                        <HelperText>
                                            <HelperTextItem variant="indeterminate">
                                                {existing_hint}
                                            </HelperTextItem>
                                        </HelperText>
                                    </>
                                );
                            }
                        },
                    ],
                    Action: {
                        Title: _("Create"),
                        action: async function (vals) {
                            await client.zfs_pool_call(pool_path, "CreateDataset", [vals.name, {}]);
                        }
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

export function create_volume(pool_path, pool_name) {
    const pool = client.zfs_pools[pool_path];
    const max_size = pool ? Number(pool.Free) : undefined;

    dialog_open({
        Title: cockpit.format(_("Create ZFS volume on $0"), pool_name),
        Fields: [
            TextInput("name", _("Name"), {
                validate: val => {
                    if (val === "")
                        return _("Name cannot be empty");
                    if (val.startsWith("-"))
                        return _("Name cannot start with '-'");
                    if (val.indexOf("/") >= 0)
                        return _("Name cannot contain '/'");
                    if (/[\s@#]/.test(val))
                        return _("Name cannot contain spaces, '@', or '#'");
                    return null;
                }
            }),
            SizeSlider("size", _("Size"), {
                max: max_size,
                round: 512,
            }),
        ],
        Action: {
            Title: _("Create"),
            action: async function (vals) {
                await client.zfs_pool_call(pool_path, "CreateVolume", [vals.name, vals.size, {}]);
            }
        }
    });
}

export function create_snapshot(pool_path, pool_name) {
    // Fetch current datasets dynamically so the dialog always has fresh data
    client.zfs_pool_call(pool_path, "ListDatasets", [{ type: { t: 's', v: 'all' } }])
            .then(result => {
                const parsed = result[0].map(parse_dataset);
                // Both filesystems and volumes can be snapshotted
                const snappable_datasets = parsed.filter(d => d.type === "filesystem" || d.type === "volume");
                if (snappable_datasets.length === 0) {
                    dialog_open({
                        Title: _("No datasets"),
                        Body: _("There are no datasets available to snapshot."),
                    });
                    return;
                }

                dialog_open({
                    Title: cockpit.format(_("Create ZFS snapshot on $0"), pool_name),
                    Fields: [
                        SelectOne("dataset", _("Dataset"), {
                            choices: snappable_datasets.map(d => ({
                                value: d.name,
                                title: d.type === "volume"
                                    ? cockpit.format("$0 ($1)", d.name, _("volume"))
                                    : d.name,
                            })),
                        }),
                        TextInput("snap_name", _("Snapshot name"), {
                            validate: val => {
                                if (val === "")
                                    return _("Snapshot name cannot be empty");
                                if (val.indexOf("/") >= 0)
                                    return _("Name cannot contain '/'");
                                if (val.indexOf("@") >= 0)
                                    return _("Name cannot contain '@'");
                                if (val.indexOf(" ") >= 0)
                                    return _("Name cannot contain spaces");
                                return null;
                            }
                        }),
                    ],
                    Action: {
                        Title: _("Create"),
                        action: async function (vals) {
                            await client.zfs_pool_call(pool_path, "CreateSnapshot", [vals.dataset, vals.snap_name, false, {}]);
                        }
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

/* ---- internal helpers ---- */

function destroy_dataset(pool_path, dataset_name, dataset_type) {
    const type_labels = {
        snapshot: _("snapshot"),
        bookmark: _("bookmark"),
    };
    const label = type_labels[dataset_type] || _("dataset");

    if (dataset_type === "bookmark") {
        dialog_open({
            Title: cockpit.format(_("Permanently destroy $0 $1?"), label, dataset_name),
            Action: {
                Title: _("Destroy"),
                Danger: cockpit.format(_("Destroying a $0 will permanently delete all data it contains. This action cannot be undone."), label),
                action: async function () {
                    await client.zfs_pool_call(pool_path, "DestroyBookmark", [dataset_name, {}]);
                }
            }
        });
        return;
    }

    dialog_open({
        Title: cockpit.format(_("Permanently destroy $0 $1?"), label, dataset_name),
        Fields: [
            CheckBoxes("destroy_options", _("Options"), {
                fields: [
                    { tag: "force_unmount", title: _("Force unmount") },
                    { tag: "recursive", title: _("Recursive destroy (include children)") },
                ],
            }),
        ],
        Action: {
            Title: _("Destroy"),
            Danger: cockpit.format(_("Destroying a $0 will permanently delete all data it contains. This action cannot be undone."), label),
            action: async function (vals) {
                const recursive = !!(vals.destroy_options && vals.destroy_options.recursive);
                const options = {};
                if (vals.destroy_options && vals.destroy_options.force_unmount)
                    options.force = { t: 'b', v: true };
                await client.zfs_pool_call(pool_path, "DestroyDataset", [dataset_name, recursive, options]);
            }
        }
    });
}

function mount_dataset(pool_path, dataset_name) {
    return client.zfs_pool_call(pool_path, "MountDataset", [dataset_name, {}]);
}

function unmount_dataset(pool_path, dataset_name) {
    dialog_open({
        Title: cockpit.format(_("Unmount $0?"), dataset_name),
        Action: {
            Title: _("Unmount"),
            action: async function () {
                await client.zfs_pool_call(pool_path, "UnmountDataset", [dataset_name, false, {}]);
            }
        }
    });
}

function rename_dataset(pool_path, dataset_name) {
    // Split into prefix (pool/parent/) and the leaf component
    const slash_idx = dataset_name.lastIndexOf("/");
    const prefix = slash_idx >= 0 ? dataset_name.substring(0, slash_idx + 1) : "";
    const current_component = slash_idx >= 0 ? dataset_name.substring(slash_idx + 1) : dataset_name;

    dialog_open({
        Title: cockpit.format(_("Rename $0"), dataset_name),
        Fields: [
            {
                tag: "new_name",
                title: _("New name"),
                options: {
                    validate: val => {
                        if (val === "")
                            return _("Name cannot be empty");
                        if (val.startsWith("-"))
                            return _("Name cannot start with '-'");
                        if (/[\s@#/]/.test(val))
                            return _("Name cannot contain spaces, '/', '@', or '#'");
                        if (val === current_component)
                            return _("New name must be different");
                        return null;
                    },
                },
                initial_value: current_component,
                render: (val, change, validated) => {
                    return (
                        <InputGroup>
                            { prefix && <InputGroupText>{prefix}</InputGroupText> }
                            <InputGroupItem isFill>
                                <TextInputPF
                                    data-field="new_name"
                                    data-field-type="text-input"
                                    validated={validated}
                                    aria-label={_("New name")}
                                    value={val}
                                    onChange={(_event, value) => change(value)} />
                            </InputGroupItem>
                        </InputGroup>
                    );
                }
            },
        ],
        Action: {
            Title: _("Rename"),
            action: async function (vals) {
                const full_new_name = prefix + vals.new_name;
                await client.zfs_pool_call(pool_path, "RenameDataset", [dataset_name, full_new_name, {}]);
            }
        }
    });
}

function rollback_snapshot(pool_path, snapshot_name) {
    dialog_open({
        Title: cockpit.format(_("Rollback to snapshot $0?"), snapshot_name),
        Fields: [
            CheckBoxes("rollback_options", _("Options"), {
                fields: [
                    { tag: "force_unmount", title: _("Force unmount") },
                    { tag: "destroy_newer", title: _("Destroy snapshots newer than this one") },
                ],
            }),
        ],
        Action: {
            Title: _("Rollback"),
            Danger: _("Rolling back to a snapshot will discard all changes made after the snapshot was created. This action cannot be undone."),
            action: async function (vals) {
                const options = {};
                if (vals.rollback_options && vals.rollback_options.force_unmount)
                    options.force = { t: 'b', v: true };
                if (vals.rollback_options && vals.rollback_options.destroy_newer)
                    options.destroy_newer = { t: 'b', v: true };
                await client.zfs_pool_call(pool_path, "RollbackSnapshot", [snapshot_name, options]);
            }
        }
    });
}

function clone_snapshot(pool_path, snapshot_name) {
    dialog_open({
        Title: cockpit.format(_("Clone snapshot $0"), snapshot_name),
        Fields: [
            TextInput("clone_name", _("Clone name"), {
                validate: val => {
                    if (val === "")
                        return _("Clone name cannot be empty");
                    if (val.startsWith("-"))
                        return _("Name cannot start with '-'");
                    if (/[\s@#]/.test(val))
                        return _("Name cannot contain spaces, '@', or '#'");
                    return null;
                }
            }),
        ],
        Action: {
            Title: _("Clone"),
            action: async function (vals) {
                await client.zfs_pool_call(pool_path, "CloneSnapshot", [snapshot_name, vals.clone_name, {}]);
            }
        }
    });
}

const KNOWN_DATASET_TYPES = ["filesystem", "volume", "snapshot", "bookmark"];

function parse_dataset(d) {
    const raw_type = d.type?.v || "";
    return {
        name: d.name?.v || "",
        type: KNOWN_DATASET_TYPES.includes(raw_type) ? raw_type : "unknown",
        raw_type: raw_type,
        mountpoint: d.mountpoint?.v ?? null,
        mounted: d.mounted?.v || false,
        used: Number(d.used?.v || 0),
        available: Number(d.available?.v || 0),
        referenced: Number(d.referenced?.v || 0),
        compression: d.compression?.v || "off",
        encryption: d.encryption?.v ?? null,
        key_status: d["key-status"]?.v ?? null,
        origin: d.origin?.v || "-",
    };
}

function type_label(type) {
    switch (type) {
    case "filesystem": return _("Filesystem");
    case "volume": return _("Volume");
    case "snapshot": return _("Snapshot");
    case "bookmark": return _("Bookmark");
    case "unknown": return _("Unknown");
    default: return type;
    }
}

function type_label_color(type) {
    switch (type) {
    case "filesystem": return "blue";
    case "volume": return "cyan";
    case "snapshot": return "orange";
    case "bookmark": return "purple";
    default: return "grey";
    }
}

function encryption_label(d) {
    if (!d.encryption || d.encryption === "off" || d.encryption === "-") {
        return <Label isCompact color="grey">{_("off")}</Label>;
    }

    const algo = d.encryption;
    if (d.key_status === "unavailable") {
        return <Label isCompact color="red">{cockpit.format("$0 ($1)", algo, _("locked"))}</Label>;
    }

    return <Label isCompact color="green">{cockpit.format("$0 ($1)", algo, _("unlocked"))}</Label>;
}

function create_bookmark(pool_path, snapshot_name) {
    // snapshot_name is like "pool/dataset@snap" — extract the base dataset name
    const at_idx = snapshot_name.indexOf("@");
    const base = at_idx >= 0 ? snapshot_name.substring(0, at_idx) : snapshot_name;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const default_name = base + "#bookmark-" + today;

    dialog_open({
        Title: cockpit.format(_("Create bookmark from snapshot $0"), snapshot_name),
        Fields: [
            TextInput("bookmark_name", _("Bookmark name"), {
                value: default_name,
                validate: val => {
                    if (val === "")
                        return _("Bookmark name cannot be empty");
                    if (val.indexOf("#") < 0)
                        return _("Bookmark name must contain '#'");
                    return null;
                }
            }),
        ],
        Action: {
            Title: _("Create"),
            action: async function (vals) {
                await client.zfs_pool_call(pool_path, "CreateBookmark", [snapshot_name, vals.bookmark_name, {}]);
            }
        }
    });
}

/* ---- main component ---- */

export const ZFSDatasetsCard = ({ card, pool }) => {
    const pool_path = pool.path;
    const [datasets, setDatasets] = useState(null);
    const [error, setError] = useState(null);
    const [typeFilter, setTypeFilter] = useState("all");
    const [searchText, setSearchText] = useState("");
    const [activeSortIndex, setActiveSortIndex] = useState(0); // Name column
    const [activeSortDirection, setActiveSortDirection] = useState("asc");

    const refresh = useCallback(() => {
        client.zfs_pool_call(pool_path, "ListDatasets", [{ type: { t: 's', v: 'all' } }])
                .then(result => {
                    const parsed = result[0].map(parse_dataset);
                    setDatasets(parsed);
                    setError(null);
                })
                .catch(err => {
                    setError(err.toString());
                    setDatasets(null);
                });
    }, [pool_path]);

    useEffect(() => {
        refresh();

        // Re-fetch whenever D-Bus state changes (covers mutations done via dialogs)
        function on_changed() {
            refresh();
        }
        client.addEventListener("changed", on_changed);
        return () => client.removeEventListener("changed", on_changed);
    }, [refresh]);

    // Build a lookup of mountpoints by dataset name so snapshots can
    // derive their accessible path from the parent filesystem.
    const mountpoint_map = {};
    if (datasets) {
        for (const d of datasets) {
            if (d.mountpoint && d.type === "filesystem")
                mountpoint_map[d.name] = d.mountpoint;
        }
    }

    function display_mountpoint(d) {
        if (d.mountpoint)
            return d.mountpoint;
        if (d.type === "snapshot") {
            const at = d.name.indexOf("@");
            if (at >= 0) {
                const parent = d.name.substring(0, at);
                const snap = d.name.substring(at + 1);
                const parent_mp = mountpoint_map[parent];
                if (parent_mp)
                    return parent_mp + "/.zfs/snapshot/" + snap;
            }
        }
        return null;
    }

    const is_filtered = typeFilter !== "all" || searchText !== "";

    const filtered = datasets
        ? datasets.filter(d => {
            if (typeFilter !== "all" && d.type !== typeFilter)
                return false;
            if (searchText !== "" && !d.name.toLowerCase().includes(searchText.toLowerCase()))
                return false;
            return true;
        })
        : [];

    // Sort columns: 0=Name, 4=Used, 5=Available (indices match the table column order)
    const sortable_column_keys = { 0: "name", 4: "used", 5: "available" };

    const sorted = [...filtered].sort((a, b) => {
        const key = sortable_column_keys[activeSortIndex];
        if (!key) return 0;
        let cmp;
        if (key === "name") {
            cmp = a.name.localeCompare(b.name);
        } else {
            cmp = a[key] - b[key];
        }
        return activeSortDirection === "asc" ? cmp : -cmp;
    });

    function onSort(_event, index, direction) {
        setActiveSortIndex(index);
        setActiveSortDirection(direction);
    }

    function getSortParams(columnIndex) {
        if (!(columnIndex in sortable_column_keys))
            return {};
        return {
            sort: {
                sortBy: {
                    index: activeSortIndex,
                    direction: activeSortDirection,
                },
                onSort,
                columnIndex,
            }
        };
    }

    function clearAllFilters() {
        setTypeFilter("all");
        setSearchText("");
    }

    const dataset_actions = (d) => {
        if (d.type === "snapshot") {
            return (
                <StorageBarMenu label={_("Actions")} isKebab menuItems={[
                    <StorageMenuItem key="rollback"
                                     onClick={() => rollback_snapshot(pool_path, d.name)}>
                        {_("Rollback")}
                    </StorageMenuItem>,
                    <StorageMenuItem key="clone"
                                     onClick={() => clone_snapshot(pool_path, d.name)}>
                        {_("Clone")}
                    </StorageMenuItem>,
                    pool.CanBookmark
                        ? <StorageMenuItem key="bookmark"
                                           onClick={() => create_bookmark(pool_path, d.name)}>
                            {_("Create bookmark")}
                        </StorageMenuItem>
                        : null,
                    <StorageMenuItem key="hold"
                                     onClick={() => hold_snapshot(pool_path, d.name)}>
                        {_("Add hold")}
                    </StorageMenuItem>,
                    <StorageMenuItem key="release"
                                     onClick={() => release_snapshot(pool_path, d.name)}>
                        {_("Release hold")}
                    </StorageMenuItem>,
                    <StorageMenuItem key="properties"
                                     onClick={() => view_properties(pool_path, d.name)}>
                        {_("Properties")}
                    </StorageMenuItem>,
                    <StorageMenuItem key="destroy" danger
                                     onClick={() => destroy_dataset(pool_path, d.name, d.type)}>
                        {_("Destroy")}
                    </StorageMenuItem>,
                ]} />
            );
        }

        // Bookmarks and unknown types — only properties and destroy are safe
        if (d.type === "bookmark" || d.type === "unknown") {
            return (
                <StorageBarMenu label={_("Actions")} isKebab menuItems={[
                    <StorageMenuItem key="properties"
                                     onClick={() => view_properties(pool_path, d.name)}>
                        {_("Properties")}
                    </StorageMenuItem>,
                    <StorageMenuItem key="destroy" danger
                                     onClick={() => destroy_dataset(pool_path, d.name, d.type)}>
                        {_("Destroy")}
                    </StorageMenuItem>,
                ]} />
            );
        }

        // Filesystem and volume actions
        const is_clone = d.origin && d.origin !== "-" && d.origin !== "";
        const is_encrypted = d.encryption && d.encryption !== "off";

        return (
            <StorageBarMenu label={_("Actions")} isKebab menuItems={[
                d.type === "filesystem" && d.mounted
                    ? <StorageMenuItem key="unmount"
                                       onClick={() => unmount_dataset(pool_path, d.name)}>
                        {_("Unmount")}
                    </StorageMenuItem>
                    : null,
                d.type === "filesystem" && !d.mounted && d.mountpoint != null && d.mountpoint !== "legacy" && d.mountpoint !== "none" && d.key_status !== "unavailable"
                    ? <StorageMenuItem key="mount"
                                       onClick={() => mount_dataset(pool_path, d.name)}>
                        {_("Mount")}
                    </StorageMenuItem>
                    : null,
                is_clone
                    ? <StorageMenuItem key="promote"
                                       onClick={() => promote_clone(pool_path, d.name)}>
                        {_("Promote")}
                    </StorageMenuItem>
                    : null,
                d.type === "volume"
                    ? <StorageMenuItem key="resize"
                                       onClick={() => resize_volume(pool_path, d.name)}>
                        {_("Resize")}
                    </StorageMenuItem>
                    : null,
                is_encrypted && d.key_status === "unavailable"
                    ? <StorageMenuItem key="load-key"
                                       onClick={() => load_key(pool_path, d.name)}>
                        {_("Load key")}
                    </StorageMenuItem>
                    : null,
                is_encrypted && d.key_status !== "unavailable"
                    ? <StorageMenuItem key="unload-key"
                                       onClick={() => unload_key(pool_path, d.name)}>
                        {_("Unload key")}
                    </StorageMenuItem>
                    : null,
                is_encrypted
                    ? <StorageMenuItem key="change-key"
                                       onClick={() => change_key(pool_path, d.name)}>
                        {_("Change key")}
                    </StorageMenuItem>
                    : null,
                <StorageMenuItem key="inherit"
                                 onClick={() => inherit_property(pool_path, d.name)}>
                    {_("Inherit property")}
                </StorageMenuItem>,
                <StorageMenuItem key="rename"
                                 onClick={() => rename_dataset(pool_path, d.name)}>
                    {_("Rename")}
                </StorageMenuItem>,
                <StorageMenuItem key="properties"
                                 onClick={() => view_properties(pool_path, d.name)}>
                    {_("Properties")}
                </StorageMenuItem>,
                <StorageMenuItem key="destroy" danger
                                 onClick={() => destroy_dataset(pool_path, d.name, d.type)}>
                    {_("Destroy")}
                </StorageMenuItem>,
            ].filter(Boolean)} />
        );
    };

    return (
        <StorageCard card={card}>
            <CardBody>
                <Toolbar>
                    <ToolbarContent>
                        <ToolbarItem>
                            <ToggleGroup aria-label={_("Filter by type")}>
                                <ToggleGroupItem isSelected={typeFilter === "all"}
                                                 buttonId="all"
                                                 text={_("All types")}
                                                 onChange={() => setTypeFilter("all")} />
                                <ToggleGroupItem isSelected={typeFilter === "filesystem"}
                                                 buttonId="filesystem"
                                                 text={_("Filesystems")}
                                                 onChange={() => setTypeFilter("filesystem")} />
                                <ToggleGroupItem isSelected={typeFilter === "volume"}
                                                 buttonId="volume"
                                                 text={_("Volumes")}
                                                 onChange={() => setTypeFilter("volume")} />
                                <ToggleGroupItem isSelected={typeFilter === "snapshot"}
                                                 buttonId="snapshot"
                                                 text={_("Snapshots")}
                                                 onChange={() => setTypeFilter("snapshot")} />
                                <ToggleGroupItem isSelected={typeFilter === "bookmark"}
                                                 buttonId="bookmark"
                                                 text={_("Bookmarks")}
                                                 onChange={() => setTypeFilter("bookmark")} />
                            </ToggleGroup>
                        </ToolbarItem>
                        { datasets !== null && is_filtered &&
                            <ToolbarItem>
                                {cockpit.format(_("Showing $0 of $1 datasets"), filtered.length, datasets.length)}
                            </ToolbarItem>
                        }
                        <ToolbarItem align={{ default: "alignEnd" }}>
                            <SearchInput id="zfs-datasets-search"
                                         placeholder={_("Filter by name")}
                                         value={searchText}
                                         onChange={(_event, val) => setSearchText(val)}
                                         onClear={() => setSearchText("")} />
                        </ToolbarItem>
                    </ToolbarContent>
                </Toolbar>
            </CardBody>
            <CardBody className="contains-list">
                { error &&
                    <Alert variant="danger" isInline title={_("Failed to load datasets")}>
                        {error}
                    </Alert>
                }
                { datasets === null && !error &&
                    <EmptyState>
                        <Spinner size="lg" />
                        <EmptyStateBody>{_("Loading datasets...")}</EmptyStateBody>
                    </EmptyState>
                }
                { datasets !== null && filtered.length === 0 && !error && !is_filtered &&
                    <EmptyState>
                        <EmptyStateBody>{_("No datasets")}</EmptyStateBody>
                    </EmptyState>
                }
                { datasets !== null && filtered.length === 0 && !error && is_filtered &&
                    <EmptyState>
                        <EmptyStateBody>{_("No datasets match the current filter")}</EmptyStateBody>
                        <Button variant="link" onClick={clearAllFilters}>
                            {_("Clear all filters")}
                        </Button>
                    </EmptyState>
                }
                { datasets !== null && filtered.length > 0 && !error &&
                    <Table aria-label={_("Datasets")} variant="compact">
                        <Thead>
                            <Tr>
                                <Th {...getSortParams(0)}>{_("Name")}</Th>
                                <Th>{_("Type")}</Th>
                                <Th>{_("Mountpoint")}</Th>
                                <Th>{_("Mounted")}</Th>
                                <Th {...getSortParams(4)}>{_("Used")}</Th>
                                <Th {...getSortParams(5)}>{_("Available")}</Th>
                                <Th>{_("Compression")}</Th>
                                <Th>{_("Encryption")}</Th>
                                <Th aria-label={_("Actions")} />
                            </Tr>
                        </Thead>
                        <Tbody>
                            { sorted.map(d => (
                                <Tr key={d.name}>
                                    <Td>{d.name}</Td>
                                    <Td>
                                        <Label isCompact color={type_label_color(d.type)}>
                                            {type_label(d.type)}
                                        </Label>
                                    </Td>
                                    <Td>{display_mountpoint(d) ?? "-"}</Td>
                                    <Td>{d.type === "filesystem" ? (d.mounted ? _("Yes") : _("No")) : "-"}</Td>
                                    <Td>{fmt_size(d.used)}</Td>
                                    <Td>{fmt_size(d.available)}</Td>
                                    <Td>{d.compression}</Td>
                                    <Td>{encryption_label(d)}</Td>
                                    <Td className="pf-v6-c-table__action">
                                        {dataset_actions(d)}
                                    </Td>
                                </Tr>
                            )) }
                        </Tbody>
                    </Table>
                }
            </CardBody>
        </StorageCard>
    );
};
