/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import cockpit from "cockpit";
import React, { useState, useEffect, useCallback } from "react";
import client from "../client";

import { CardBody } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { Toolbar, ToolbarContent, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar/index.js";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect/index.js";
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { EmptyState, EmptyStateBody } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Badge } from "@patternfly/react-core/dist/esm/components/Badge/index.js";

import { InputGroup, InputGroupItem, InputGroupText } from "@patternfly/react-core/dist/esm/components/InputGroup/index.js";
import { TextInput as TextInputPF } from "@patternfly/react-core/dist/esm/components/TextInput/index.js";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText/index.js";

import { StorageCard } from "../pages.jsx";
import { StorageBarMenu, StorageMenuItem } from "../storage-controls.jsx";
import { dialog_open, TextInput, SelectOne } from "../dialog.jsx";
import { fmt_size } from "../utils.js";

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
                                    if (val.indexOf(" ") >= 0)
                                        return _("Name cannot contain spaces");
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
    dialog_open({
        Title: cockpit.format(_("Create ZFS volume on $0"), pool_name),
        Fields: [
            TextInput("name", _("Name"), {
                validate: val => {
                    if (val === "")
                        return _("Name cannot be empty");
                    if (val.indexOf("/") >= 0)
                        return _("Name cannot contain '/'");
                    if (val.indexOf(" ") >= 0)
                        return _("Name cannot contain spaces");
                    return null;
                }
            }),
            TextInput("size", _("Size (bytes)"), {
                validate: val => {
                    const n = Number(val);
                    if (isNaN(n) || n <= 0)
                        return _("Size must be a positive number");
                    return null;
                }
            }),
        ],
        Action: {
            Title: _("Create"),
            action: async function (vals) {
                await client.zfs_pool_call(pool_path, "CreateVolume", [vals.name, Number(vals.size), {}]);
            }
        }
    });
}

export function create_snapshot(pool_path, pool_name) {
    // Fetch current datasets dynamically so the dialog always has fresh data
    client.zfs_pool_call(pool_path, "ListDatasets", [{ type: { t: 's', v: 'all' } }])
            .then(result => {
                const parsed = result[0].map(parse_dataset);
                const filesystem_datasets = parsed.filter(d => d.type === "filesystem");
                if (filesystem_datasets.length === 0) {
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
                            choices: filesystem_datasets.map(d => ({
                                value: d.name,
                                title: d.name,
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
    const label = dataset_type === "snapshot" ? _("snapshot") : _("dataset");
    dialog_open({
        Title: cockpit.format(_("Permanently destroy $0 $1?"), label, dataset_name),
        Action: {
            Title: _("Destroy"),
            Danger: cockpit.format(_("Destroying a $0 will permanently delete all data it contains. This action cannot be undone."), label),
            action: async function () {
                await client.zfs_pool_call(pool_path, "DestroyDataset", [dataset_name, false, {}]);
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
    dialog_open({
        Title: cockpit.format(_("Rename $0"), dataset_name),
        Fields: [
            TextInput("new_name", _("New name"), {
                value: dataset_name,
                validate: val => {
                    if (val === "")
                        return _("Name cannot be empty");
                    if (val === dataset_name)
                        return _("New name must be different");
                    return null;
                }
            }),
        ],
        Action: {
            Title: _("Rename"),
            action: async function (vals) {
                await client.zfs_pool_call(pool_path, "RenameDataset", [dataset_name, vals.new_name, {}]);
            }
        }
    });
}

function rollback_snapshot(pool_path, snapshot_name) {
    dialog_open({
        Title: cockpit.format(_("Rollback to snapshot $0?"), snapshot_name),
        Action: {
            Title: _("Rollback"),
            Danger: _("Rolling back to a snapshot will discard all changes made after the snapshot was created. This action cannot be undone."),
            action: async function () {
                await client.zfs_pool_call(pool_path, "RollbackSnapshot", [snapshot_name, {}]);
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
                    if (val.indexOf(" ") >= 0)
                        return _("Name cannot contain spaces");
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

function parse_dataset(d) {
    return {
        name: d.name?.v || "",
        type: d.type?.v || "filesystem",
        mountpoint: d.mountpoint?.v || "-",
        mounted: d.mounted?.v || false,
        used: Number(d.used?.v || 0),
        available: Number(d.available?.v || 0),
        referenced: Number(d.referenced?.v || 0),
        compression: d.compression?.v || "off",
        encryption: d.encryption?.v || "off",
        origin: d.origin?.v || "-",
    };
}

function type_label(type) {
    switch (type) {
    case "filesystem": return _("Filesystem");
    case "volume": return _("Volume");
    case "snapshot": return _("Snapshot");
    default: return type;
    }
}

function type_badge_color(type) {
    switch (type) {
    case "filesystem": return "blue";
    case "volume": return "cyan";
    case "snapshot": return "orange";
    default: return "grey";
    }
}

/* ---- main component ---- */

export const ZFSDatasetsCard = ({ card, pool }) => {
    const pool_path = pool.path;
    const [datasets, setDatasets] = useState(null);
    const [error, setError] = useState(null);
    const [typeFilter, setTypeFilter] = useState("all");

    const refresh = useCallback(() => {
        client.zfs_pool_call(pool_path, "ListDatasets", [{ type: { t: 's', v: 'all' } }])
                .then(result => {
                    const parsed = result[0].map(parse_dataset);
                    setDatasets(parsed);
                    setError(null);
                })
                .catch(err => {
                    console.warn("ListDatasets failed:", err);
                    setError(err.toString());
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

    const filtered = datasets
        ? datasets.filter(d => typeFilter === "all" || d.type === typeFilter)
        : [];

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
                    <StorageMenuItem key="destroy" danger
                                     onClick={() => destroy_dataset(pool_path, d.name, d.type)}>
                        {_("Destroy")}
                    </StorageMenuItem>,
                ]} />
            );
        }

        return (
            <StorageBarMenu label={_("Actions")} isKebab menuItems={[
                d.type === "filesystem" && d.mounted
                    ? <StorageMenuItem key="unmount"
                                       onClick={() => unmount_dataset(pool_path, d.name)}>
                        {_("Unmount")}
                    </StorageMenuItem>
                    : null,
                d.type === "filesystem" && !d.mounted
                    ? <StorageMenuItem key="mount"
                                       onClick={() => mount_dataset(pool_path, d.name)}>
                        {_("Mount")}
                    </StorageMenuItem>
                    : null,
                <StorageMenuItem key="rename"
                                 onClick={() => rename_dataset(pool_path, d.name)}>
                    {_("Rename")}
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
                            <FormSelect value={typeFilter}
                                        aria-label={_("Filter by type")}
                                        onChange={(_, val) => setTypeFilter(val)}>
                                <FormSelectOption value="all" label={_("All types")} />
                                <FormSelectOption value="filesystem" label={_("Filesystems")} />
                                <FormSelectOption value="volume" label={_("Volumes")} />
                                <FormSelectOption value="snapshot" label={_("Snapshots")} />
                            </FormSelect>
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
                { datasets !== null && filtered.length === 0 && !error &&
                    <EmptyState>
                        <EmptyStateBody>{_("No datasets")}</EmptyStateBody>
                    </EmptyState>
                }
                { datasets !== null && filtered.length > 0 &&
                    <Table aria-label={_("ZFS datasets")} variant="compact">
                        <Thead>
                            <Tr>
                                <Th>{_("Name")}</Th>
                                <Th>{_("Type")}</Th>
                                <Th>{_("Mountpoint")}</Th>
                                <Th>{_("Mounted")}</Th>
                                <Th>{_("Used")}</Th>
                                <Th>{_("Available")}</Th>
                                <Th>{_("Compression")}</Th>
                                <Th aria-label={_("Actions")} />
                            </Tr>
                        </Thead>
                        <Tbody>
                            { filtered.map(d => (
                                <Tr key={d.name}>
                                    <Td>{d.name}</Td>
                                    <Td>
                                        <Badge screenReaderText={type_label(d.type)}
                                               style={{ backgroundColor: type_badge_color(d.type) }}>
                                            {type_label(d.type)}
                                        </Badge>
                                    </Td>
                                    <Td>{d.mountpoint}</Td>
                                    <Td>{d.type === "filesystem" ? (d.mounted ? _("Yes") : _("No")) : "-"}</Td>
                                    <Td>{fmt_size(d.used)}</Td>
                                    <Td>{fmt_size(d.available)}</Td>
                                    <Td>{d.compression}</Td>
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
