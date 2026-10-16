import type { AiAnswer, AiAskRequest, AiProvider } from './types';

/**
 * Deterministic fixture provider for development and tests. It performs no
 * network access and holds no credentials; the same request always produces
 * the same answer, computed only from the snapshot in the request. It is a
 * stand-in for a real model: it summarises the selection, lists layers,
 * searches permitted text, and describes individual objects.
 */
export const FIXTURE_PROVIDER_ID = 'fixture';

function objectLine(request: AiAskRequest, id: string): string | null {
  const obj = request.snapshot.objects.find((o) => o.id === id);
  if (!obj) return null;
  const parts = [`${obj.id}: ${obj.type} on layer ${obj.layer}`];
  const g = obj.geometry;
  if (typeof g.length === 'number') parts.push(`length ${g.length}`);
  if (typeof g.radius === 'number') parts.push(`radius ${g.radius}`);
  if (typeof g.block === 'string') parts.push(`block ${g.block}`);
  if (obj.text !== undefined) parts.push(`text "${obj.text}"`);
  if (obj.attributes) {
    parts.push(`attributes ${obj.attributes.map((a) => `${a.tag}=${a.value}`).join(', ')}`);
  }
  return parts.join('; ');
}

function summarise(request: AiAskRequest): string {
  const { snapshot } = request;
  const lines: string[] = [];
  const unit = snapshot.units.insunitsName;
  lines.push(
    `${snapshot.selection.included} of ${snapshot.selection.total} selected objects`
    + ` (units: ${unit}, space: ${snapshot.space.kind})`,
  );
  const byType = new Map<string, number>();
  const byLayer = new Map<string, number>();
  for (const obj of snapshot.objects) {
    byType.set(obj.type, (byType.get(obj.type) ?? 0) + 1);
    byLayer.set(obj.layer, (byLayer.get(obj.layer) ?? 0) + 1);
  }
  if (byType.size > 0) {
    lines.push(`Types: ${[...byType.entries()].map(([t, n]) => `${t} ×${n}`).join(', ')}`);
    lines.push(`Layers: ${[...byLayer.entries()].map(([t, n]) => `${t} ×${n}`).join(', ')}`);
  }
  if (snapshot.selection.omittedCount > 0) {
    lines.push(`${snapshot.selection.omittedCount} selected object(s) were omitted from the context (see the snapshot for reasons).`);
  }
  return lines.join('\n');
}

export function fixtureRespond(request: AiAskRequest): AiAnswer {
  const question = request.question.trim().toLowerCase();
  const references: string[] = [];
  let text: string;

  // "describe e-line" / an id mentioned in the question → that object only.
  const mentioned = request.snapshot.objects.filter((o) => question.includes(o.id.toLowerCase()));
  if (mentioned.length > 0) {
    text = mentioned
      .map((o) => objectLine(request, o.id))
      .filter((line): line is string => line !== null)
      .join('\n');
    references.push(...mentioned.map((o) => o.id));
    return { text, references };
  }

  if (/\b(count|how many)\b/.test(question)) {
    text = summarise(request);
    return { text, references };
  }

  if (question.startsWith('find ') || question.startsWith('search ')) {
    const needle = question.replace(/^(find|search)\s+/, '').trim();
    const hits = request.snapshot.objects.filter((o) =>
      (o.text?.toLowerCase().includes(needle) ?? false)
      || (o.attributes?.some((a) => a.value.toLowerCase().includes(needle)
        || a.tag.toLowerCase().includes(needle)) ?? false)
      || (o.tableText?.some((cell) => cell.toLowerCase().includes(needle)) ?? false));
    if (hits.length === 0) {
      text = `No selected object contains "${needle}".`;
    } else {
      text = hits.map((o) => objectLine(request, o.id)).filter((l): l is string => l !== null).join('\n');
      references.push(...hits.map((o) => o.id));
    }
    return { text, references };
  }

  if (/\blayers?\b/.test(question)) {
    const layers = new Map<string, number>();
    for (const obj of request.snapshot.objects) layers.set(obj.layer, (layers.get(obj.layer) ?? 0) + 1);
    text = layers.size === 0
      ? 'No objects are included in the snapshot.'
      : `Selected objects are on: ${[...layers.entries()].map(([l, n]) => `${l} (${n})`).join(', ')}`;
    return { text, references };
  }

  text = summarise(request);
  return { text, references };
}

export class FixtureProvider implements AiProvider {
  readonly id = FIXTURE_PROVIDER_ID;

  async ask(request: AiAskRequest, signal: AbortSignal): Promise<AiAnswer> {
    if (signal.aborted) throw new Error('Fixture request aborted.');
    return fixtureRespond(request);
  }
}
