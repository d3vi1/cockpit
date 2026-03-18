/*
 * Copyright (C) 2024 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * React component that renders a storage topology graph using
 * @patternfly/react-topology.
 *
 * The visualization controller is kept at module scope (singleton) so
 * that layout positions, zoom, and pan survive page-tree rebuilds
 * (the same pattern used by PlotState elsewhere in Cockpit).
 */

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import client from "../client";

import {
    TopologyControlBar,
    TopologyView,
    Visualization,
    VisualizationProvider,
    VisualizationSurface,
    createTopologyControlButtons,
    ColaLayout,
    DagreLayout,
    DefaultEdge,
    DefaultGroup,
    DefaultNode,
    GraphComponent,
    ModelKind,
    Graph,
    withPanZoom,
    withSelection,
} from "@patternfly/react-topology";

import { buildTopologyModel, fetchAsyncTopologyData } from "./topology-builder.js";
import { storageComponentFactory } from "./topology-node.jsx";

import "./topology.scss";

/* ── LR Dagre Layout ───────────────────────────────────────────── */

/**
 * Custom DagreLayout subclass that forces LR (left-to-right) direction
 * by swapping x/y coordinates after dagre computes a TB layout.
 *
 * This works around a bug in @dagrejs/dagre where rankdir: 'LR' is
 * ignored when compound graphs are used with @patternfly/react-topology.
 */
class DagreLRLayout extends DagreLayout {
    constructor(graph, options) {
        super(graph, {
            rankdir: 'LR',
            nodesep: 40,
            edgesep: 20,
            ranksep: 80,
            nodeDistance: 40,
            linkDistance: 20,
            ...options,
        });
    }

    startLayout(graph, initialRun, addingNodes) {
        // Run the standard Dagre TB layout first
        super.startLayout(graph, initialRun, addingNodes);

        // After dagre finishes (which produces TB positions),
        // swap x and y coordinates on every node to produce LR flow.
        if (this.nodes) {
            this.nodes.forEach(node => {
                const ox = node.x;
                const oy = node.y;
                node.x = oy;
                node.y = ox;
                node.update();
            });
        }
        // Also swap edge bendpoints
        if (this.edges) {
            this.edges.forEach(edge => {
                if (edge.bendpoints) {
                    edge.bendpoints = edge.bendpoints.map(bp => ({
                        x: bp.y,
                        y: bp.x,
                    }));
                }
            });
        }
    }
}

/* ── Layout factory ─────────────────────────────────────────────── */

function storageLayoutFactory(type, graph) {
    switch (type) {
        case 'Dagre':
            return new DagreLRLayout(graph);
        case 'Cola':
            return new ColaLayout(graph, {
                flowDirection: 'x',
            });
        default:
            return new DagreLRLayout(graph);
    }
}

/* ── Component factory fallback ──────────────────────────────────── */

function defaultStorageComponentFactory(kind, type) {
    switch (kind) {
        case ModelKind.graph:
            return withPanZoom()(GraphComponent);
        case ModelKind.node:
            return withSelection()(DefaultNode);
        case ModelKind.edge:
            return DefaultEdge;
        case ModelKind.group:
            return DefaultGroup;
        default:
            return undefined;
    }
}

/* ── module-scope singleton ──────────────────────────────────────── */

let controllerInstance = null;
let lastModelHash = null;

function getController() {
    if (!controllerInstance) {
        const vis = new Visualization();
        vis.registerLayoutFactory(storageLayoutFactory);
        vis.registerComponentFactory(storageComponentFactory);
        vis.registerComponentFactory(defaultStorageComponentFactory);
        controllerInstance = vis;
    }
    return controllerInstance;
}

/* ── TopologyGraph component ─────────────────────────────────────── */

export const TopologyGraph = () => {
    const controller = useMemo(() => getController(), []);
    const [asyncData, setAsyncData] = useState(null);
    const debounceRef = useRef(null);
    const hasFittedRef = useRef(false);

    // Fetch async data (ZFS vdev topology) on mount
    useEffect(() => {
        let cancelled = false;
        fetchAsyncTopologyData(client).then(data => {
            if (!cancelled)
                setAsyncData(data);
        });
        return () => { cancelled = true };
    }, []);

    // Build and apply the topology model
    const updateModel = useCallback(() => {
        const model = buildTopologyModel(client, asyncData);
        // Only push to the controller if the structure actually changed
        const hash = JSON.stringify(
            model.nodes.map(n => n.id).sort()
                    .concat(model.edges.map(e => e.id).sort())
        );
        if (hash !== lastModelHash) {
            lastModelHash = hash;
            controller.fromModel(model, false);
            // Explicitly trigger layout after model update to ensure
            // the Dagre LR direction is applied
            try {
                const g = controller.getGraph();
                if (g) {
                    g.layout();
                }
            } catch (e) {
                console.warn("topology: explicit layout() call failed:", e);
            }
        }
    }, [controller, asyncData]);

    useEffect(() => {
        updateModel();

        // Auto-fit on first render: wait for the Dagre layout to finish,
        // then fit the entire graph into the viewport with 80px padding.
        if (!hasFittedRef.current) {
            hasFittedRef.current = true;
            setTimeout(() => {
                try {
                    const g = controller.getGraph();
                    if (g) g.fit(80);
                } catch (e) {
                    console.warn("topology: fit-on-first-render failed:", e);
                }
            }, 500);
        }

        function onChanged() {
            if (debounceRef.current)
                clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => {
                fetchAsyncTopologyData(client).then(data => {
                    setAsyncData(data);
                });
                updateModel();
            }, 2000);
        }

        client.addEventListener("changed", onChanged);
        return () => {
            client.removeEventListener("changed", onChanged);
            if (debounceRef.current)
                clearTimeout(debounceRef.current);
        };
    }, [updateModel]);

    // Control bar for zoom / fit / reset
    const controlButtons = useMemo(() => {
        return createTopologyControlButtons({
            zoomInCallback: () => {
                const g = controller.getGraph();
                if (g) g.scaleBy(4 / 3);
            },
            zoomOutCallback: () => {
                const g = controller.getGraph();
                if (g) g.scaleBy(3 / 4);
            },
            fitToScreenCallback: () => {
                const g = controller.getGraph();
                if (g) g.fit(80);
            },
            resetViewCallback: () => {
                const g = controller.getGraph();
                if (g) g.reset();
            },
            legend: false,
        });
    }, [controller]);

    return (
        <div className="storage-topology-container">
            <VisualizationProvider controller={controller}>
                <TopologyView
                    controlBar={<TopologyControlBar controlButtons={controlButtons} />}
                >
                    <VisualizationSurface />
                </TopologyView>
            </VisualizationProvider>
        </div>
    );
};

export default TopologyGraph;
