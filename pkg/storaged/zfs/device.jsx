/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import cockpit from "cockpit";
import React from "react";
import client from "../client";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { CardBody } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";

import { StorageCard, StorageDescription, new_card, register_crossref } from "../pages.jsx";
import { fmt_zfs_state, zfs_pool_state_color } from "./utils.jsx";
import { import_zfs_pool } from "./dialogs.jsx";

const _ = cockpit.gettext;

export function make_zfs_device_card(next, block, content_block, zfs_proxy) {
    /* zfs_proxy can be either Block.ZFS (pool member) or Filesystem.ZFS (zvol).
     * Block.ZFS has: Pool (object path)
     * Filesystem.ZFS has: Pool (object path), PoolName (string), DatasetName (string)
     */
    const pool_path = zfs_proxy.Pool;
    let pool = (pool_path && pool_path !== "/") ? client.zfs_pools[pool_path] : null;

    /* Fallback: if Pool object path is "/" (race condition — pool not yet discovered
     * when block interface was created), look up pool by IdLabel or PoolName */
    const label = content_block.IdLabel || zfs_proxy.PoolName || "";
    if (!pool && label) {
        for (const p of Object.values(client.zfs_pools)) {
            if (p.Name === label) {
                pool = p;
                break;
            }
        }
    }

    /* Determine if this is a zvol (Filesystem.ZFS) or pool member (Block.ZFS) */
    const is_zvol = !!zfs_proxy.DatasetName;
    const dataset_name = zfs_proxy.DatasetName || "";
    const pool_name = pool ? pool.Name : (label || _("Unknown pool"));

    const title = is_zvol ? _("ZFS volume") : _("ZFS pool member");

    const card_actions = [];
    const is_spare = !pool && !label;
    const is_not_imported = !pool && label && !is_zvol;

    if (is_not_imported) {
        card_actions.push({
            title: _("Import pool"),
            action: () => import_zfs_pool(),
        });
    }

    let location;
    if (pool) {
        location = { label: pool_name, to: ["zpool", pool_name] };
    } else if (is_spare) {
        location = { label: _("Spare device") };
    } else if (is_not_imported) {
        location = { label: pool_name + " " + _("(not imported)") };
    } else if (pool_name) {
        location = { label: pool_name };
    }

    const zfs_card = new_card({
        title: is_spare ? _("ZFS spare") : title,
        location,
        next,
        actions: card_actions,
        component: ZFSDeviceCard,
        props: { block, content_block, zfs_proxy, is_zvol, pool_name, dataset_name },
    });

    if (pool) {
        register_crossref({
            key: pool_path,
            card: zfs_card,
            size: block.Size,
        });
    }

    return zfs_card;
}

const ZFSDeviceCard = ({ card, block, content_block, zfs_proxy, is_zvol, pool_name, dataset_name }) => {
    const pool_path = zfs_proxy.Pool;
    let pool = (pool_path && pool_path !== "/") ? client.zfs_pools[pool_path] : null;
    if (!pool && pool_name) {
        for (const p of Object.values(client.zfs_pools))
            if (p.Name === pool_name) { pool = p; break; }
    }

    return (
        <StorageCard card={card}>
            <CardBody>
                <DescriptionList className="pf-m-horizontal-on-sm">
                    <StorageDescription title={_("ZFS pool")}>
                        {pool
                            ? <Button variant="link" isInline role="link"
                                   onClick={() => cockpit.location.go(["zpool", pool_name])}>
                                {pool_name}
                            </Button>
                            : pool_name || _("Unknown pool")
                        }
                    </StorageDescription>
                    { !pool && !pool_name &&
                    <StorageDescription title={_("Status")} value={_("Spare device")} />
                    }
                    { !pool && pool_name && pool_name !== _("Unknown pool") &&
                    <StorageDescription title={_("Status")} value={_("Not imported")} />
                    }
                    { is_zvol && dataset_name &&
                    <StorageDescription title={_("Dataset name")} value={dataset_name} />
                    }
                    { pool &&
                    <StorageDescription title={_("Pool state")}>
                        <Flex spaceItems={{ default: 'spaceItemsSm' }}>
                            <FlexItem>
                                <span style={{ color: zfs_pool_state_color(pool.State) }}>&#x2B24;</span>
                            </FlexItem>
                            <FlexItem>
                                {fmt_zfs_state(pool.State)}
                            </FlexItem>
                        </Flex>
                    </StorageDescription>
                    }
                </DescriptionList>
            </CardBody>
        </StorageCard>
    );
};
