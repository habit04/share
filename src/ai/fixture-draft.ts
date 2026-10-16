import { parseAiDraftResponse, type AiDraftResponse, type AiPlanOperation } from './draft-plan';
import { AiError, type AiDraftProvider, type AiDraftRefineRequest, type AiDraftRequest } from './types';
import { AI_DRAFT_MAX_CONTEXT_BYTES, AI_MAX_QUESTION_CHARS } from './limits';

/**
 * Deterministic offline draft demonstrations (docs/AI-ASSISTANT-M3.md). A
 * bounded pattern set over the user's wording, reading eligible target ids
 * from the same context JSON a live provider would receive. Anything else
 * returns a clarification explaining what the demo can do. Labelled
 * "Offline demonstration" in the panel; no network, no keys.
 */

function eligibleIds(request: AiDraftRequest): string[] {
  try {
    const context = JSON.parse(request.contextJson) as { targets?: { id?: unknown; eligible?: unknown }[] };
    if (!Array.isArray(context.targets)) return [];
    return context.targets
      .filter((t) => t && t.eligible === true && typeof t.id === 'string')
      .map((t) => t.id as string);
  } catch {
    return [];
  }
}

function number(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  if (!match || match[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function vector(text: string): { dx: number; dy: number } | null {
  const by = /by\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/i.exec(text);
  if (by) return { dx: Number(by[1]), dy: Number(by[2]) };
  const directional = /\b(?:move|copy)\s+(?:(?:the\s+)?(?:selected\s+)?(?:objects?|entities|selection)\s+)?(-?\d+(?:\.\d+)?)\s*(?:units?\s*)?(right|left|up(?:ward)?|down(?:ward)?)\b/i.exec(text);
  if (!directional) return null;
  const amount = Number(directional[1]);
  if (directional[2] === 'right') return { dx: amount, dy: 0 };
  if (directional[2] === 'left') return { dx: -amount, dy: 0 };
  if (directional[2]?.startsWith('up')) return { dx: 0, dy: amount };
  if (directional[2]?.startsWith('down')) return { dx: 0, dy: -amount };
  return null;
}

function build(raw: unknown): AiDraftResponse {
  const parsed = parseAiDraftResponse(raw);
  if (parsed.ok) return parsed.response;
  return {
    kind: 'clarification',
    message: 'The offline demonstration could not build that plan. Try one of the documented demonstrations.',
  };
}

const DEMO_HELP = 'The offline demonstration can: create a rectangle (e.g. "create a 100 x 60 rectangle with four circles of radius 3, centered 10 units from each corner"), move, copy, rotate (with an explicit pivot, e.g. "rotate 90 degrees about (0, 0)") or delete the eligible selected objects (e.g. "move 10 units right", "copy 25 up", "delete"). Connect a live provider for free-form drafting.';

const REFINE_HELP = 'The offline demonstration can refine a preview with: "change the rectangle width to 120" (corner circles keep their inset), "change the radius to 5", "remove Circle 2" (use the labels in the change list), or "change that movement to 15 units right in total". Connect a live provider for free-form refinements.';

export class FixtureDraftProvider implements AiDraftProvider {
  readonly id = 'fixture-draft';

  async draft(request: AiDraftRequest, signal: AbortSignal): Promise<AiDraftResponse> {
    if (signal.aborted) throw new AiError('cancelled', 'The draft request was cancelled.');
    if (request.prompt.length > AI_MAX_QUESTION_CHARS) throw new AiError('invalid-question', 'The draft description is too long.');
    if (request.contextJson.length > AI_DRAFT_MAX_CONTEXT_BYTES || new TextEncoder().encode(request.contextJson).length > AI_DRAFT_MAX_CONTEXT_BYTES) {
      throw new AiError('invalid-context', 'The draft context exceeds the offline demonstration limit.');
    }
    const text = request.prompt.toLowerCase();
    const ids = eligibleIds(request);
    // The demo recognizes simple examples, not arbitrary prose. Refuse
    // wording it would otherwise partly interpret or silently discard.
    if (/\b(?:not|never|without|except|only|dont|don't|don’t|then|also|and|layer)\b/.test(text)) {
      return { kind: 'clarification', message: 'The offline demo needs one simple instruction without conditions or layer changes. Connect a live provider for more detailed requests.' };
    }
    if (/\b(?:mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|inch(?:es)?|feet|foot|ft|met(?:er|re)s?|yards?)\b/.test(text)) {
      return { kind: 'clarification', message: 'The offline demo uses drawing units only. Specify drawing-unit values or connect a live provider for physical-unit conversion.' };
    }
    if (/(?<![\d.])[-+]?\.\d|\d[eE][-+]?\d|[-+]\s+\d/.test(text)) {
      return { kind: 'clarification', message: 'Use ordinary decimal numbers with a leading digit in the offline demo, e.g. 0.5 or -0.5.' };
    }
    const actionWords = new Set((text.match(/\b(?:delete|erase|remove|rotate|move|copy|create|draw)\b/g) ?? [])
      .map((word) => word === 'erase' || word === 'remove' ? 'delete' : word === 'draw' ? 'create' : word));
    if (actionWords.size > 1) return { kind: 'clarification', message: 'The offline demo handles one action at a time. Generate and review each action separately.' };

    if (/\bdelete\b|\berase\b|\bremove\b/.test(text)) {
      if (ids.length === 0) return { kind: 'clarification', message: 'Select at least one eligible object first, then ask to delete it.' };
      return build({ outcome: 'proposal', message: 'Offline demonstration plan.', operations: [{ op: 'delete', targetIds: ids }] });
    }
    if (/\brotate\b/.test(text)) {
      if (ids.length === 0) return { kind: 'clarification', message: 'Select at least one eligible object first, then ask to rotate it.' };
      const angle = number(text, /(-?\d+(?:\.\d+)?)\s*(?:degrees|°|deg)/);
      const pivotMatch = /about\s*\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?/i.exec(text);
      if (angle === null || !pivotMatch) {
        return { kind: 'clarification', message: 'Rotation needs an explicit angle and pivot, e.g. "rotate 90 degrees about (0, 0)".' };
      }
      return build({
        outcome: 'proposal', message: 'Offline demonstration plan.',
        operations: [{ op: 'rotate', targetIds: ids, pivot: { x: Number(pivotMatch[1]), y: Number(pivotMatch[2]) }, angleDeg: angle }],
      });
    }
    if (/\bmove\b/.test(text) || /\bcopy\b/.test(text)) {
      const isCopy = /\bcopy\b/.test(text);
      if (ids.length === 0) return { kind: 'clarification', message: `Select at least one eligible object first, then ask to ${isCopy ? 'copy' : 'move'} it.` };
      const v = vector(text);
      const directions = text.match(/\b(?:right|left|up(?:ward)?|down(?:ward)?)\b/g) ?? [];
      if (!v || directions.length > 1) return { kind: 'clarification', message: `Say how far in one direction, e.g. "${isCopy ? 'copy' : 'move'} 10 units right" or "${isCopy ? 'copy' : 'move'} by (5, -2)".` };
      return build({
        outcome: 'proposal', message: 'Offline demonstration plan.',
        operations: [{ op: isCopy ? 'copy' : 'move', targetIds: ids, dx: v.dx, dy: v.dy }],
      });
    }
    if (/\brectangle\b/.test(text)) {
      const dims = /(-?\d+(?:\.\d+)?)\s*(?:x|×|by)\s*(-?\d+(?:\.\d+)?)/i.exec(text);
      if (!dims) return { kind: 'clarification', message: 'What size rectangle? E.g. "create a 100 x 60 rectangle".' };
      const width = Number(dims[1]);
      const height = Number(dims[2]);
      if (/\brotat/.test(text)) return { kind: 'clarification', message: 'The offline rectangle demo is axis aligned. Use a separate rotation instruction or connect a live provider.' };
      const origin = /at\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/i.exec(text);
      if (/\bat\b/.test(text) && !origin) return { kind: 'clarification', message: 'Give the rectangle origin explicitly, e.g. "at (5, 10)".' };
      const x = origin ? Number(origin[1]) : 0;
      const y = origin ? Number(origin[2]) : 0;
      const operations: unknown[] = [{ op: 'createRectangle', origin: { x, y }, width, height, rotationDeg: null, layer: null }];
      if (/\bcircle/.test(text)) {
        const radius = number(text, /radius\s*(?:of\s*)?(\d+(?:\.\d+)?)/);
        const inset = number(text, /(-?\d+(?:\.\d+)?)\s*(?:units?\s*)?from each corner/);
        if (!/\b(?:four|4)\s+circles\b/.test(text) || inset === null || inset < 0) {
          return { kind: 'clarification', message: 'For the offline rectangle-and-circles demo, specify four circles and their distance from each corner.' };
        }
        if (radius === null) return { kind: 'clarification', message: 'What circle radius? E.g. "four circles of radius 3".' };
        for (const [cx, cy] of [[inset, inset], [width - inset, inset], [width - inset, height - inset], [inset, height - inset]] as const) {
          operations.push({ op: 'createCircle', center: { x: x + cx, y: y + cy }, radius, layer: null });
        }
      }
      return build({ outcome: 'proposal', message: 'Offline demonstration plan.', operations });
    }
    if (/\bline\b/.test(text)) {
      const pts = /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)\s*(?:to|-)\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/i.exec(text);
      if (!pts) return { kind: 'clarification', message: 'Give both endpoints, e.g. "line from (0, 0) to (50, 25)".' };
      return build({
        outcome: 'proposal', message: 'Offline demonstration plan.',
        operations: [{ op: 'createLine', a: { x: Number(pts[1]), y: Number(pts[2]) }, b: { x: Number(pts[3]), y: Number(pts[4]) }, layer: null }],
      });
    }
    if (/\bcircle\b/.test(text)) {
      const radius = number(text, /radius\s*(?:of\s*)?(\d+(?:\.\d+)?)/);
      const center = /at\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/i.exec(text);
      if (radius === null) return { kind: 'clarification', message: 'What circle radius? E.g. "circle of radius 5 at (10, 10)".' };
      if (/\bat\b/.test(text) && !center) return { kind: 'clarification', message: 'Give the circle center explicitly, e.g. "at (10, 10)".' };
      return build({
        outcome: 'proposal', message: 'Offline demonstration plan.',
        operations: [{ op: 'createCircle', center: center ? { x: Number(center[1]), y: Number(center[2]) } : { x: 0, y: 0 }, radius, layer: null }],
      });
    }
    return { kind: 'clarification', message: DEMO_HELP };
  }

  /**
   * Milestone 4: deterministic follow-up refinements of the staged plan.
   * The follow-up edits the CURRENT PLAN (a complete replacement is
   * returned, still evaluated against the original drawing); anything the
   * demo cannot do exactly returns a clarification instead of a guess.
   */
  async refine(request: AiDraftRefineRequest, signal: AbortSignal): Promise<AiDraftResponse> {
    if (signal.aborted) throw new AiError('cancelled', 'The refinement was cancelled.');
    if (request.followUp.length > AI_MAX_QUESTION_CHARS) throw new AiError('invalid-question', 'The follow-up instruction is too long.');
    if (new TextEncoder().encode(request.envelopeJson).length > AI_DRAFT_MAX_CONTEXT_BYTES) {
      throw new AiError('invalid-context', 'The refinement context exceeds the offline demonstration limit.');
    }
    let envelope: { currentPlan?: { message?: unknown; operations?: unknown } };
    try { envelope = JSON.parse(request.envelopeJson) as typeof envelope; }
    catch { return { kind: 'clarification', message: 'The offline demonstration could not read the current preview.' }; }
    const parsed = parseAiDraftResponse({ outcome: 'proposal', message: envelope.currentPlan?.message ?? null, operations: envelope.currentPlan?.operations });
    if (!parsed.ok || parsed.response.kind !== 'plan') {
      return { kind: 'clarification', message: 'The offline demonstration could not read the current preview plan.' };
    }
    const operations = JSON.parse(JSON.stringify(parsed.response.plan.operations)) as AiPlanOperation[];
    const text = request.followUp.toLowerCase();
    if (/\b(?:mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|inch(?:es)?|feet|foot|ft|met(?:er|re)s?|yards?)\b/.test(text)) {
      return { kind: 'clarification', message: 'The offline demo uses drawing units only. Specify drawing-unit values or connect a live provider for physical-unit conversion.' };
    }
    if (/\b(?:not|never|without|except|only|dont|don't|don’t)\b/.test(text)) {
      return { kind: 'clarification', message: 'The offline demo needs one simple follow-up without conditions. Connect a live provider for more detailed refinements.' };
    }
    const clarify = (message: string): AiDraftResponse => ({ kind: 'clarification', message });
    const finish = (): AiDraftResponse => operations.length === 0
      ? clarify('That would remove the whole preview. Use Discard to abandon it instead.')
      : build({ outcome: 'proposal', message: 'Offline demonstration plan.', operations });
    const rectangles = operations.filter((op) => op.op === 'createRectangle');
    const circles = operations.filter((op) => op.op === 'createCircle');

    // "Change the rectangle to 120 by 80" / "width to 120" / "height to 80",
    // keeping corner-inset circles at their inset from the new corners.
    const adjustCornerCircles = (rect: Extract<AiPlanOperation, { op: 'createRectangle' }>, newWidth: number, newHeight: number): void => {
      if (circles.length !== 4) return;
      const inset = circles[0]!.center.x - rect.origin.x;
      const eps = 1e-9;
      const expected: readonly (readonly [number, number])[] = [
        [inset, inset], [rect.width - inset, inset], [rect.width - inset, rect.height - inset], [inset, rect.height - inset],
      ];
      const matches = circles.every((circle, i) => Math.abs(circle.center.x - rect.origin.x - expected[i]![0]) < eps
        && Math.abs(circle.center.y - rect.origin.y - expected[i]![1]) < eps
        && circle.radius === circles[0]!.radius);
      if (!matches) return;
      const corners: readonly (readonly [number, number])[] = [
        [inset, inset], [newWidth - inset, inset], [newWidth - inset, newHeight - inset], [inset, newHeight - inset],
      ];
      circles.forEach((circle, i) => {
        (circle as { center: { x: number; y: number } }).center = { x: rect.origin.x + corners[i]![0], y: rect.origin.y + corners[i]![1] };
      });
    };
    const both = /rectangle\s+to\s+(\d+(?:\.\d+)?)\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)/.exec(text);
    const widthOnly = number(text, /(?:rectangle\s+)?width\s+to\s+(\d+(?:\.\d+)?)/);
    const heightOnly = number(text, /(?:rectangle\s+)?height\s+to\s+(\d+(?:\.\d+)?)/);
    if (both || widthOnly !== null || heightOnly !== null) {
      if (rectangles.length !== 1) return clarify('The current preview does not contain exactly one rectangle to resize.');
      const rect = rectangles[0]!;
      const newWidth = both ? Number(both[1]) : widthOnly ?? rect.width;
      const newHeight = both ? Number(both[2]) : heightOnly ?? rect.height;
      adjustCornerCircles(rect, newWidth, newHeight);
      (rect as { width: number }).width = newWidth;
      (rect as { height: number }).height = newHeight;
      return finish();
    }

    const radius = number(text, /radius\s+to\s+(\d+(?:\.\d+)?)/);
    if (radius !== null) {
      if (circles.length === 0) return clarify('The current preview contains no new circle whose radius can change.');
      const shared = circles.every((circle) => circle.radius === circles[0]!.radius);
      if (!shared && circles.length > 1) return clarify('Which circle do you mean? The preview circles have different radii; name one, e.g. "Circle 2".');
      for (const circle of circles) (circle as { radius: number }).radius = radius;
      return finish();
    }

    const remove = /remove\s+(?:the\s+|that\s+|this\s+)?(?:new\s+)?(circle|rectangle|line)(?:\s+(\d+))?/.exec(text);
    if (remove) {
      const kind = `create${remove[1]![0]!.toUpperCase()}${remove[1]!.slice(1)}`;
      const matches = operations
        .map((op, index) => ({ op, index }))
        .filter(({ op }) => op.op === kind);
      if (matches.length === 0) return clarify(`The current preview contains no new ${remove[1]} to remove.`);
      let target = matches[0];
      if (remove[2] !== undefined) {
        target = matches[Number(remove[2]) - 1];
        if (!target) return clarify(`There is no ${remove[1]} ${remove[2]} in the current preview.`);
      } else if (matches.length > 1) {
        return clarify(`Which ${remove[1]}? The preview has ${matches.length}; name one by its label, e.g. "${remove[1]![0]!.toUpperCase()}${remove[1]!.slice(1)} 2".`);
      }
      operations.splice(target!.index, 1);
      return finish();
    }

    const moves = operations.filter((op) => op.op === 'move');
    const scaleTo = number(text, /(?:change|set)\s+(?:that\s+|the\s+)?movement\s+to\s+(\d+(?:\.\d+)?)/);
    const axisTotal = /(\d+(?:\.\d+)?)\s*(?:units?\s*)?(right|left|up(?:ward)?|down(?:ward)?)\s+in\s+total/.exec(text)
      ?? /to\s+(\d+(?:\.\d+)?)\s*(?:units?\s*)?(right|left|up(?:ward)?|down(?:ward)?)(?:\s+in\s+total)?/.exec(text);
    if (scaleTo !== null || axisTotal) {
      if (moves.length !== 1) return clarify('The current preview does not contain exactly one movement to change.');
      const move = moves[0]!;
      if (axisTotal) {
        const amount = Number(axisTotal[1]);
        const direction = axisTotal[2]!;
        (move as { dx: number }).dx = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
        (move as { dy: number }).dy = direction.startsWith('up') ? amount : direction.startsWith('down') ? -amount : 0;
      } else {
        const length = Math.hypot(move.dx, move.dy);
        if (length === 0) return clarify('The current movement has no direction to scale.');
        (move as { dx: number }).dx = (move.dx / length) * scaleTo!;
        (move as { dy: number }).dy = (move.dy / length) * scaleTo!;
      }
      return finish();
    }

    const angle = number(text, /angle\s+to\s+(-?\d+(?:\.\d+)?)/);
    if (angle !== null) {
      const rotates = operations.filter((op) => op.op === 'rotate');
      if (rotates.length !== 1) return clarify('The current preview does not contain exactly one rotation to change.');
      (rotates[0] as { angleDeg: number }).angleDeg = angle;
      return finish();
    }

    return clarify(REFINE_HELP);
  }
}
