/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import cockpit from "cockpit";
import React from "react";
import client from "../client";

import { CardBody } from "@patternfly/react-core/dist/esm/components/Card/index.js";
import { DescriptionList } from "@patternfly/react-core/dist/esm/components/DescriptionList/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";

import { VolumeIcon } from "../icons/gnome-icons.jsx";

import {
    new_card, new_page, PAGE_CATEGORY_VIRTUAL,
    StorageCard, StorageDescription,
} from "../pages.jsx";
import { StorageUsageBar } from "../storage-controls.jsx";
import { fmt_size_long } from "../utils.js";
import { fmt_zfs_state, zfs_pool_state_color } from "./utils.jsx";

const _ = cockpit.gettext;

export function make_zfs_pool_page(parent, pool) {
    const use = [Number(pool.Allocated), Number(pool.Size)];

    const pool_card = new_card({
        title: _("ZFS pool"),
        next: null,
        page_location: ["zpool", pool.Name],
        page_name: pool.Name,
        page_icon: VolumeIcon,
        page_category: PAGE_CATEGORY_VIRTUAL,
        page_size: (use[1]
            ? <StorageUsageBar key="s" stats={use} short />
            : Number(pool.Size)),
        job_path: pool.path,
        component: ZFSPoolCard,
        props: { pool, use },
    });

    new_page(parent, pool_card);
}

const ZFSPoolCard = ({ card, pool, use }) => {
    const state_color = zfs_pool_state_color(pool.State);
    const state_text = fmt_zfs_state(pool.State);
    const health_text = fmt_zfs_state(pool.Health);

    const scrub_status = pool.ScrubRunning
        ? (pool.ScrubPaused
            ? _("Paused")
            : cockpit.format(_("Running ($0%)"), (pool.ScrubProgress * 100).toFixed(1)))
        : _("Not running");

    return (
        <StorageCard card={card}>
            <CardBody>
                <DescriptionList className="pf-m-horizontal-on-sm">
                    <StorageDescription title={_("Name")} value={pool.Name} />
                    <StorageDescription title={_("GUID")} value={pool.GUID} />
                    <StorageDescription title={_("State")}>
                        <Flex spaceItems={{ default: 'spaceItemsSm' }}>
                            <FlexItem>
                                <span style={{ color: state_color }}>&#x2B24;</span>
                            </FlexItem>
                            <FlexItem>
                                {state_text}
                            </FlexItem>
                        </Flex>
                    </StorageDescription>
                    <StorageDescription title={_("Health")} value={health_text} />
                    <StorageDescription title={_("Capacity")} value={fmt_size_long(Number(pool.Size))} />
                    <StorageDescription title={_("Usage")}>
                        <StorageUsageBar key="s" stats={use} />
                    </StorageDescription>
                    <StorageDescription title={_("Dedup ratio")} value={pool.DedupRatio} />
                    <StorageDescription title={_("Fragmentation")} value={pool.Fragmentation} />
                    <StorageDescription title={_("Read only")} value={pool.ReadOnly ? _("Yes") : _("No")} />
                    { pool.Altroot && pool.Altroot !== "-" &&
                    <StorageDescription title={_("Alternate root")} value={pool.Altroot} />
                    }
                    <StorageDescription title={_("Scrub")}>
                        {scrub_status}
                        { pool.ScrubRunning && pool.ScrubErrors > 0 &&
                        <span> ({cockpit.format(_("$0 errors"), pool.ScrubErrors)})</span>
                        }
                    </StorageDescription>
                </DescriptionList>
            </CardBody>
        </StorageCard>
    );
};
