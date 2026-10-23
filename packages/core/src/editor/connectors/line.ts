import type { SceneNode } from '@open-pencil/scene-graph'
import {
  connectorRoute,
  curveControlPoints,
  dragCurve,
  dragElbowSegment,
  elbowJoints,
  type ConnectorPiece
} from '@open-pencil/scene-graph/connectors'
import { getParentWorldMatrix } from '@open-pencil/scene-graph/coordinate'
import Matrix from '@open-pencil/scene-graph/matrix'
import type { Vector } from '@open-pencil/scene-graph/primitives'

import type { NodePreview } from '#core/editor/node-preview'
import type { EditorContext } from '#core/editor/types'

type BeginNodePreview = (label?: string) => NodePreview

/** What a drag on a connector's line holds: an elbow segment by its index, or the curve. */
export type ConnectorLinePart = { kind: 'segment'; index: number } | { kind: 'curve' }

interface LineDrag {
  connectorId: string
  part: ConnectorLinePart
  /** Where the press was, in the connector's parent's axes. */
  press: Vector
  /** The route as the drag found it, in the connector's parent's axes. */
  pieces: ConnectorPiece[]
  joints: [Vector, Vector]
  handles: [Vector, Vector] | null
  preview: NodePreview
}

function shifted(point: Vector, by: Vector): Vector {
  return { x: point.x + by.x, y: point.y + by.y }
}

/**
 * Dragging a selected connector's line, as FigJam does: an elbow segment moves across itself, to
 * whole pixels, and a curve bends so the point midway along it follows the pointer. The
 * connector keeps the result as its control points, and one undo step puts the line back.
 */
export function createConnectorLineActions(ctx: EditorContext, beginNodePreview: BeginNodePreview) {
  let drag: LineDrag | null = null

  /** A canvas point in the connector's parent's axes. */
  function inParent(connector: SceneNode, x: number, y: number): Vector {
    const parent = connector.parentId ? ctx.graph.getNode(connector.parentId) : undefined
    const toParent = Matrix.invert(getParentWorldMatrix(parent, ctx.graph)) ?? Matrix.identity()
    return Matrix.mapPoint(toParent, { x, y })
  }

  function connectorLineBegin(connectorId: string, part: ConnectorLinePart, x: number, y: number) {
    connectorLineCancel()
    const connector = ctx.graph.getNode(connectorId)
    const route = connector ? connectorRoute(ctx.graph, connector) : null
    if (!connector || !route) return
    const curve = route.pieces.at(0)
    drag = {
      connectorId,
      part,
      press: inParent(connector, x, y),
      pieces: route.pieces,
      joints: elbowJoints(route.start, route.end, route.sides),
      handles: route.controls.curve ?? (curve ? curveControlPoints(curve) : null),
      preview: beginNodePreview(part.kind === 'curve' ? 'Bend connector' : 'Move connector segment')
    }
  }

  function connectorLineDrag(x: number, y: number) {
    const current = drag
    const connector = current ? ctx.graph.getNode(current.connectorId) : undefined
    if (!current || !connector) return
    const point = inParent(connector, x, y)
    const delta = { x: point.x - current.press.x, y: point.y - current.press.y }
    // Control points sit in the connector's own axes.
    const local = { x: -connector.x, y: -connector.y }
    if (current.part.kind === 'curve') {
      if (!current.handles) return
      const [first, second] = dragCurve(current.handles, delta)
      current.preview.update(connector.id, {
        connectorCurveHandles: [shifted(first, local), shifted(second, local)]
      })
      return
    }
    const piece = current.pieces.at(current.part.index)
    if (!piece) return
    const vertical = piece.from.x === piece.to.x
    const offset = Math.round(vertical ? piece.from.x + delta.x : piece.from.y + delta.y)
    const points = dragElbowSegment(current.pieces, current.joints, current.part.index, offset)
    current.preview.update(connector.id, {
      connectorControlPoints: points.map((control) => ({
        ...control,
        position: shifted(control.position, local)
      }))
    })
  }

  function connectorLineCommit() {
    const current = drag
    drag = null
    current?.preview.commit()
    ctx.requestRender()
  }

  function connectorLineCancel() {
    const current = drag
    drag = null
    current?.preview.cancel()
    ctx.requestRender()
  }

  return { connectorLineBegin, connectorLineDrag, connectorLineCommit, connectorLineCancel }
}
