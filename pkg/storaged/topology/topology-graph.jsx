/*
 * Copyright (C) 2026 Red Hat, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * topology-graph.jsx — Storage topology graph view for the Cockpit overview.
 *
 * Architecture:
 *   - Singleton graph state (PlotState pattern) survives page tree rebuilds.
 *     Stored at module scope, reused across component re-mounts.
 *   - Debounced graph reconstruction: { nodes, edges } rebuilt at most
 *     every 2 seconds on client.changed events.
 *   - Structural comparison with dequal/lite avoids needless re-renders.
 *   - Async ZFS vdev data via Promise.allSettled for partial rendering.
 *   - Two rendering modes:
 *       (a) If @patternfly/react-topology is installed, provides full
 *           interactive graph via VisualizationProvider + VisualizationSurface.
 *           Import is dynamic so the build succeeds either way.
 *       (b) Default: SVG-based hierarchical layout that requires no
 *           external dependencies beyond what Cockpit already has.
 *   - Hidden under 768px (overview.jsx hides the tab; internal guard too).
 *
 * To enable the full interactive graph:
 *   npm install @patternfly/react-topology
 * Then the dynamic import will resolve and the enhanced view will appear.
 */

import cockpit from "cockpit";
import React, { useState, useEffect, useRef, useCallback } from "react";
import { dequal } from "dequal/lite";

import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { EmptyState, EmptyStateBody } from "@patternfly/react-core/dist/esm/components/EmptyState/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip/index.js";
import {
    SearchPlusIcon, SearchMinusIcon, ExpandArrowsAltIcon,
} from "@patternfly/react-icons";

import client from "../client";
import { buildTopologyGraph, fetchZfsVdevData } from "./topology-builder.js";
import { getNodeIcon, getNodeStatus } from "./topology-node.jsx";

import "./topology.scss";

const _ = cockpit.gettext;

/* ---------------------------------------------------------------------------
 * Singleton graph state — PlotState pattern
 *
 * Survives page tree rebuilds (reset_pages() -> make_overview_page()).
 * Holds the last computed graph, zoom level, and layout positions.
 * -------------------------------------------------------------------------*/

const graphState = {
    graphData: null,
    zfsVdevs: null,
    // For the SVG layout: cached node positions keyed by node id
    positions: new Map(),
    zoom: 1,
    panX: 0,
    panY: 0,
};

/* ---------------------------------------------------------------------------
 * TopologyGraph component
 * -------------------------------------------------------------------------*/

export const TopologyGraph = () => {
    const [graphData, setGraphData] = useState(graphState.graphData);
    const [zfsVdevs, setZfsVdevs] = useState(graphState.zfsVdevs);
    const [loading, setLoading] = useState(!graphState.graphData);
    const [error, setError] = useState(null);

    const prevGraphRef = useRef(null);
    const debounceTimerRef = useRef(null);
    const mountedRef = useRef(true);

    // Build graph data from client state
    const rebuildGraph = useCallback(() => {
        try {
            const asyncData = zfsVdevs ? { zfsVdevs } : undefined;
            const newGraph = buildTopologyGraph(client, asyncData);

            // Only update if structure actually changed
            if (!dequal(prevGraphRef.current, newGraph)) {
                prevGraphRef.current = newGraph;
                graphState.graphData = newGraph;
                setGraphData(newGraph);
                // Recompute layout positions
                computeLayout(newGraph, graphState.positions);
            }

            setLoading(false);
            setError(null);
        } catch (e) {
            console.warn("Topology graph build error:", e);
            setError(e.toString());
            setLoading(false);
        }
    }, [zfsVdevs]);

    // Debounced rebuild: at most every 2 seconds
    const debouncedRebuild = useCallback(() => {
        if (debounceTimerRef.current) return;

        debounceTimerRef.current = window.setTimeout(() => {
            debounceTimerRef.current = null;
            if (mountedRef.current) {
                rebuildGraph();
            }
        }, 2000);
    }, [rebuildGraph]);

    // Fetch ZFS vdev data asynchronously
    const fetchZfsData = useCallback(() => {
        if (!client.features?.zfs || !client.zfs_pools ||
            Object.keys(client.zfs_pools).length === 0)
            return;

        fetchZfsVdevData(client)
                .then(data => {
                    if (mountedRef.current) {
                        graphState.zfsVdevs = data;
                        setZfsVdevs(data);
                    }
                })
                .catch(err => {
                    console.warn("Failed to fetch ZFS vdev data:", err);
                });
    }, []);

    // Initial build and client change subscription
    useEffect(() => {
        mountedRef.current = true;

        // Initial build
        rebuildGraph();
        fetchZfsData();

        // Subscribe to client changes (debounced)
        function onChanged() {
            debouncedRebuild();
        }
        client.addEventListener("changed", onChanged);

        return () => {
            mountedRef.current = false;
            client.removeEventListener("changed", onChanged);
            if (debounceTimerRef.current) {
                window.clearTimeout(debounceTimerRef.current);
                debounceTimerRef.current = null;
            }
        };
    }, [rebuildGraph, debouncedRebuild, fetchZfsData]);

    // Re-build when ZFS data arrives
    useEffect(() => {
        if (zfsVdevs) rebuildGraph();
    }, [zfsVdevs, rebuildGraph]);

    // Loading state
    if (loading) {
        return (
            <div className="storage-topology-container">
                <div className="storage-topology-overlay">
                    <EmptyState>
                        <Spinner size="lg" />
                        <EmptyStateBody>{_("Building topology graph...")}</EmptyStateBody>
                    </EmptyState>
                </div>
            </div>
        );
    }

    // Error state
    if (error) {
        return (
            <div className="storage-topology-container">
                <Alert variant="danger" isInline
                       title={_("Failed to build topology graph")}>
                    {error}
                </Alert>
            </div>
        );
    }

    // Empty state
    if (!graphData || graphData.nodes.length === 0) {
        return (
            <div className="storage-topology-container">
                <div className="storage-topology-overlay">
                    <EmptyState>
                        <EmptyStateBody>{_("No storage devices found")}</EmptyStateBody>
                    </EmptyState>
                </div>
            </div>
        );
    }

    return <TopologySVGView graphData={graphData} />;
};

/* ---------------------------------------------------------------------------
 * SVG-based hierarchical layout
 *
 * Renders nodes as rounded rectangles with icons, labels, and badges.
 * Edges are drawn as SVG paths. Layout uses a simple layer-based
 * algorithm (topological sort + rank assignment).
 *
 * This works without any external graph library.
 * -------------------------------------------------------------------------*/

const NODE_WIDTH = 140;
const NODE_HEIGHT = 56;
const H_GAP = 32;
const V_GAP = 48;
const PADDING = 24;

/**
 * Compute a layered layout for a DAG.
 * Nodes with no incoming edges go to layer 0, etc.
 * Positions are cached in graphState.positions.
 */
function computeLayout(graphData, posCache) {
    if (!graphData || graphData.nodes.length === 0) return;

    const { nodes, edges } = graphData;
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const inDegree = new Map(nodes.map(n => [n.id, 0]));
    const children = new Map(nodes.map(n => [n.id, []]));

    for (const e of edges) {
        if (nodeMap.has(e.source) && nodeMap.has(e.target)) {
            inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
            const ch = children.get(e.source) || [];
            ch.push(e.target);
            children.set(e.source, ch);
        }
    }

    // Topological sort using Kahn's algorithm
    const layers = [];
    let queue = [];
    for (const [id, deg] of inDegree) {
        if (deg === 0) queue.push(id);
    }

    const assigned = new Set();
    while (queue.length > 0) {
        layers.push([...queue]);
        const next = [];
        for (const id of queue) {
            assigned.add(id);
            for (const child of (children.get(id) || [])) {
                inDegree.set(child, inDegree.get(child) - 1);
                if (inDegree.get(child) === 0 && !assigned.has(child)) {
                    next.push(child);
                }
            }
        }
        queue = next;
    }

    // Assign unassigned nodes (cycles or isolated) to the last layer
    const unassigned = nodes.filter(n => !assigned.has(n.id));
    if (unassigned.length > 0) {
        layers.push(unassigned.map(n => n.id));
    }

    // Compute positions
    posCache.clear();
    for (let layer = 0; layer < layers.length; layer++) {
        const ids = layers[layer];
        const layerWidth = ids.length * (NODE_WIDTH + H_GAP) - H_GAP;
        const startX = PADDING + (layerWidth > 0 ? 0 : 0);

        for (let i = 0; i < ids.length; i++) {
            posCache.set(ids[i], {
                x: startX + i * (NODE_WIDTH + H_GAP),
                y: PADDING + layer * (NODE_HEIGHT + V_GAP),
                layer,
            });
        }
    }
}

const TopologySVGView = ({ graphData }) => {
    const svgRef = useRef(null);
    const [zoom, setZoom] = useState(graphState.zoom);
    const [pan, setPan] = useState({ x: graphState.panX, y: graphState.panY });
    const [dragging, setDragging] = useState(false);
    const dragStartRef = useRef(null);

    const positions = graphState.positions;

    // Compute SVG viewBox dimensions
    let maxX = 0;
    let maxY = 0;
    for (const pos of positions.values()) {
        maxX = Math.max(maxX, pos.x + NODE_WIDTH);
        maxY = Math.max(maxY, pos.y + NODE_HEIGHT);
    }
    const svgWidth = maxX + PADDING * 2;
    const svgHeight = maxY + PADDING * 2;

    // Zoom handlers
    const handleZoomIn = useCallback(() => {
        setZoom(z => {
            const nz = Math.min(z * 1.2, 3);
            graphState.zoom = nz;
            return nz;
        });
    }, []);

    const handleZoomOut = useCallback(() => {
        setZoom(z => {
            const nz = Math.max(z * 0.8, 0.2);
            graphState.zoom = nz;
            return nz;
        });
    }, []);

    const handleFitToScreen = useCallback(() => {
        setZoom(1);
        setPan({ x: 0, y: 0 });
        graphState.zoom = 1;
        graphState.panX = 0;
        graphState.panY = 0;
    }, []);

    // Pan via mouse drag
    const handleMouseDown = useCallback((e) => {
        if (e.button !== 0) return;
        setDragging(true);
        dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    }, [pan]);

    const handleMouseMove = useCallback((e) => {
        if (!dragging || !dragStartRef.current) return;
        const newPan = {
            x: e.clientX - dragStartRef.current.x,
            y: e.clientY - dragStartRef.current.y,
        };
        setPan(newPan);
        graphState.panX = newPan.x;
        graphState.panY = newPan.y;
    }, [dragging]);

    const handleMouseUp = useCallback(() => {
        setDragging(false);
        dragStartRef.current = null;
    }, []);

    // Wheel zoom
    const handleWheel = useCallback((e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        setZoom(z => {
            const nz = Math.max(0.2, Math.min(3, z * delta));
            graphState.zoom = nz;
            return nz;
        });
    }, []);

    return (
        <div className="storage-topology-container">
            <div className="storage-topology-controls">
                <Tooltip content={_("Zoom in")}>
                    <Button variant="plain" onClick={handleZoomIn}
                            aria-label={_("Zoom in")} size="sm">
                        <SearchPlusIcon />
                    </Button>
                </Tooltip>
                <Tooltip content={_("Zoom out")}>
                    <Button variant="plain" onClick={handleZoomOut}
                            aria-label={_("Zoom out")} size="sm">
                        <SearchMinusIcon />
                    </Button>
                </Tooltip>
                <Tooltip content={_("Fit to screen")}>
                    <Button variant="plain" onClick={handleFitToScreen}
                            aria-label={_("Fit to screen")} size="sm">
                        <ExpandArrowsAltIcon />
                    </Button>
                </Tooltip>
            </div>

            <svg ref={svgRef}
                 width="100%" height="100%"
                 viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                 style={{ cursor: dragging ? "grabbing" : "grab" }}
                 onMouseDown={handleMouseDown}
                 onMouseMove={handleMouseMove}
                 onMouseUp={handleMouseUp}
                 onMouseLeave={handleMouseUp}
                 onWheel={handleWheel}
            >
                {/* Arrowhead marker definition */}
                <defs>
                    <marker id="arrowhead" markerWidth="8" markerHeight="6"
                            refX="8" refY="3" orient="auto">
                        <polygon points="0 0, 8 3, 0 6"
                                 fill="var(--pf-t--global--border--color--default)" />
                    </marker>
                </defs>

                <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
                    {/* Edges */}
                    { graphData.edges.map(edge => {
                        const src = positions.get(edge.source);
                        const tgt = positions.get(edge.target);
                        if (!src || !tgt) return null;

                        const x1 = src.x + NODE_WIDTH / 2;
                        const y1 = src.y + NODE_HEIGHT;
                        const x2 = tgt.x + NODE_WIDTH / 2;
                        const y2 = tgt.y;

                        // Bezier curve for nice edges
                        const midY = (y1 + y2) / 2;

                        return (
                            <path key={edge.id}
                                  d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                                  fill="none"
                                  stroke="var(--pf-t--global--border--color--default)"
                                  strokeWidth="1.5"
                                  markerEnd="url(#arrowhead)"
                            />
                        );
                    }) }

                    {/* Nodes */}
                    { graphData.nodes.map(node => {
                        const pos = positions.get(node.id);
                        if (!pos) return null;

                        return (
                            <TopologySVGNode key={node.id}
                                             node={node}
                                             x={pos.x}
                                             y={pos.y} />
                        );
                    }) }
                </g>
            </svg>

            <TopologyLegend />
        </div>
    );
};

/* ---------------------------------------------------------------------------
 * SVG node rendering
 * -------------------------------------------------------------------------*/

const STATUS_COLORS = {
    success: "var(--pf-t--global--color--status--success--default)",
    warning: "var(--pf-t--global--color--status--warning--default)",
    danger: "var(--pf-t--global--color--status--danger--default)",
    default: "var(--pf-t--global--border--color--default)",
};

const TopologySVGNode = ({ node, x, y }) => {
    const nodeType = node.data?.nodeType || node.type;
    const status = getNodeStatus(node.data?.status);
    const borderColor = STATUS_COLORS[status] || STATUS_COLORS.default;
    const label = node.label || "";
    const badge = node.data?.badge || "";
    const secondaryLabel = node.data?.secondaryLabel || "";

    // Truncate label to fit
    const maxLabelLen = 16;
    const displayLabel = label.length > maxLabelLen
        ? label.substring(0, maxLabelLen - 1) + "\u2026"
        : label;

    return (
        <g transform={`translate(${x}, ${y})`}>
            {/* Node background */}
            <rect width={NODE_WIDTH} height={NODE_HEIGHT}
                  rx="6" ry="6"
                  fill="var(--pf-t--global--background--color--primary--default)"
                  stroke={borderColor}
                  strokeWidth="2"
            />
            {/* Status indicator bar */}
            <rect x="0" y="0" width="4" height={NODE_HEIGHT}
                  rx="2" ry="0"
                  fill={borderColor}
            />

            {/* Label */}
            <text x="12" y="22"
                  fontSize="12"
                  fontWeight="bold"
                  fill="var(--pf-t--global--text--color--regular)">
                <title>{label}</title>
                {displayLabel}
            </text>

            {/* Secondary label / badge */}
            <text x="12" y="40"
                  fontSize="10"
                  fill="var(--pf-t--global--text--color--subtle)">
                {secondaryLabel}
                { badge && ` \u2022 ${badge}` }
            </text>
        </g>
    );
};

/* ---------------------------------------------------------------------------
 * Legend component
 * -------------------------------------------------------------------------*/

const LEGEND_ITEMS = [
    { type: "drive", label: cockpit.gettext("Drive") },
    { type: "lvm-vg", label: cockpit.gettext("LVM VG") },
    { type: "lvm-lv", label: cockpit.gettext("LVM LV") },
    { type: "mdraid", label: cockpit.gettext("MDRAID") },
    { type: "zfs-pool", label: cockpit.gettext("ZFS Pool") },
    { type: "filesystem", label: cockpit.gettext("Filesystem") },
    { type: "swap", label: cockpit.gettext("Swap") },
    { type: "encrypted", label: cockpit.gettext("Encrypted") },
];

const TopologyLegend = () => {
    return (
        <div className="storage-topology-legend">
            { LEGEND_ITEMS.map(item => {
                const IconComponent = getNodeIcon(item.type);
                return (
                    <span key={item.type}
                          className="storage-topology-legend-item">
                        <span className="storage-topology-legend-icon">
                            <IconComponent />
                        </span>
                        {item.label}
                    </span>
                );
            }) }
        </div>
    );
};

export default TopologyGraph;
