--!strict
-- The native editor projection, split by what each part does so no module is large enough to blow a load tick:
-- the session (editor_projection_session), whiteboard batches (_batch), click targets and halos (_targets) and
-- the words shown to the user (_messages). This module only gathers them under one name.
local session = require("./editor_projection_session")
local batching = require("./editor_projection_batch")
local shapes = require("./editor_projection_targets")
local messages = require("./editor_projection_messages")

export type Tag = session.Tag
export type ExpectedPage = session.ExpectedPage
export type State = session.State
export type Known = session.Known
export type Batch = batching.Batch
export type Limits = batching.Limits
export type Box = shapes.Box
export type Targets = shapes.Targets
export type TargetPlan = shapes.TargetPlan
export type ActivityPlan = shapes.ActivityPlan

local projection = {}

projection.MAX_PAGE_NODES = session.MAX_PAGE_NODES
projection.begin = session.begin
projection.advance = session.advance
projection.accept = session.accept
projection.close = session.close
projection.owned_ids = session.owned_ids
projection.offer = session.offer
projection.take = session.take
projection.complete = session.complete
projection.cancel = session.cancel
projection.reconcile = session.reconcile
projection.reconcile_shown = session.reconcile_shown
projection.orphans = session.orphans
projection.drift = session.drift
projection.BUSY_LIMIT_MS = session.BUSY_LIMIT_MS
projection.busy_action = session.busy_action
projection.QUIET_PROBES = session.QUIET_PROBES
projection.MAX_WAIT_MS = session.MAX_WAIT_MS
projection.poll_wait = session.poll_wait

projection.MAX_ADDITIONS = batching.MAX_ADDITIONS
projection.MAX_REMOVALS = batching.MAX_REMOVALS
projection.batches = batching.batches
projection.adopt = batching.adopt

projection.MAX_TARGETS = shapes.MAX_TARGETS
projection.TARGET_COLOR = shapes.TARGET_COLOR
projection.TARGET_OPACITY = shapes.TARGET_OPACITY
projection.TARGET_WIDTH = shapes.TARGET_WIDTH
projection.frames = shapes.frames
projection.activity_plan = shapes.activity_plan
projection.targets = shapes.targets
projection.removals = shapes.removals
projection.retire = shapes.retire
projection.extent = shapes.extent
projection.adopt_targets = shapes.adopt_targets
projection.forget_targets = shapes.forget_targets
projection.cap_notice = shapes.cap_notice

projection.message = messages.message
projection.start_failure = messages.start_failure
projection.is_missing_shape = messages.is_missing_shape
projection.missing_id = messages.missing_id

return projection
