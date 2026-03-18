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

const _ = cockpit.gettext;

export function make_zfs_device_card(next, block, content_block, block_zfs) {
    const pool_path = block_zfs.Pool;
    const pool = client.zfs_pools[pool_path];
    const pool_name = pool ? pool.Name : _("Unknown pool");

    const zfs_card = new_card({
        title: _("ZFS pool member"),
        location: pool
            ? {
                label: pool_name,
                to: ["zpool", pool_name],
            }
            : undefined,
        next,
        component: ZFSDeviceCard,
        props: { block, content_block, block_zfs },
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

const ZFSDeviceCard = ({ card, block, content_block, block_zfs }) => {
    const pool_path = block_zfs.Pool;
    const pool = client.zfs_pools[pool_path];
    const pool_name = pool ? pool.Name : _("Unknown pool");

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
                            : pool_name
                        }
                    </StorageDescription>
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
                    { pool &&
                    <StorageDescription title={_("Pool GUID")} value={pool.GUID} />
                    }
                </DescriptionList>
            </CardBody>
        </StorageCard>
    );
};
