// JarvisVoice 核心的型別（給 TypeScript 專案用：CubeLV、平行沙盒）。

export type Complete = (req: { system: string; user: string; schema?: object | null; timeoutMs?: number }) => Promise<string>;
export type Jev = (req: { state: unknown; questions: Record<string, Question> }) => Promise<Record<string, Answer>>;
export interface Question { type: 'choice' | 'noul' | 'score'; instructions: string; criteria?: unknown }
export interface Answer { type?: string; choice?: string; confidence?: number; noul?: number; probabilities?: Record<string, number> }

export interface Field { known?: boolean; editable?: boolean; role?: string; subrole?: string; label?: string; before?: string; after?: string; selected?: string; secure?: boolean }
export interface EditContext { app?: string; bundle?: string; window?: string; url?: string; screen?: string; field?: Field }
export type EditMode = 'insert' | 'replace_selection' | 'delete_last' | 'revert_last' | 'command';
export interface EditResult { mode: EditMode; text: string; goal?: string; app?: string; message?: string; /** 模型把不只語氣詞的話整理成空的，text 改回原稿 */ keptRaw?: boolean; ms: number }

export const MODES: EditMode[];
export const SCHEMA: object;
export function buildPrompt(input: { transcript: string; context?: EditContext; style?: string; vocabulary?: string[]; commands?: boolean }): { system: string; user: string };
export function parseResult(raw: string, opts?: { commands?: boolean }): Omit<EditResult, 'ms'> | null;
export function editSegment(input: { complete: Complete; transcript: string; context?: EditContext; style?: string; vocabulary?: string[]; commands?: boolean }): Promise<EditResult>;

export interface ScreenElement { handle: number; role: string; subrole?: string; label: string; value?: string; x: number; y: number; w: number; h: number; focused?: boolean; ocr?: boolean }
export interface Frame { x?: number; y?: number; w?: number; h?: number; title?: string }
export interface ScreenAdapter {
  elements(opts: { limit?: number; ocr?: 'never' | 'auto' | 'always' }): Promise<{ window: Frame; elements: ScreenElement[]; source?: string }>;
  act(req: { handle?: number; action: 'press' | 'fill' | 'enter' | 'clickAt' | 'focus'; text?: string; x?: number; y?: number }): Promise<{ result: string }>;
}
export interface Decider {
  available(): boolean;
  engine(): string;
  decide(state: unknown, questions: Record<string, Question>): Promise<Record<string, Answer>>;
  canEscalate(): boolean;
  escalate(state: unknown, questions: Record<string, Question>): Promise<Record<string, Answer>>;
}
export function createDecider(service: () => { jev?: Jev | null; complete?: Complete | null }): Decider;
export function intentQuestion(): Question;
export function inFieldIntentQuestion(): Question;
export function referenceQuestion(items: ScreenElement[], win?: Frame): Question;
export function recipientQuestion(name: string): Question;
export function fieldQuestions(candidates: ScreenElement[], win?: Frame): Record<string, Question>;
export function stepQuestions(elements: ScreenElement[], win?: Frame): Record<string, Question>;
export function describeElement(e: ScreenElement, win?: Frame): string;
export function inFieldVerdict(answers: Record<string, Answer>, items: ScreenElement[]): { command: number; named: ScreenElement | null; isCommand: boolean };
export const IN_FIELD_SURE: number;
export const IN_FIELD_NAMED: number;

export interface CommandResult { ok: boolean; reason?: string; steps?: string[] }
export function runCommand(input: { screen: ScreenAdapter; decider: Decider; log?: (m: string) => void; switchApp?: (name: string) => Promise<boolean>;
  goal: string; text?: string; message?: string; app?: string; context?: { app?: string }; stopped?: () => boolean }): Promise<CommandResult>;
export function messageBox(list: ScreenElement[], searchText?: string): ScreenElement | null;

export function rankTargets(input: { candidates: ScreenElement[]; window?: Frame; remembered?: { role: string; label?: string } | null }):
  { choice: ScreenElement | null; reason: string; sure: boolean; list: ScreenElement[] };
export function usable(c: ScreenElement): boolean;

export function extractEdited(value: string | null, before?: string, after?: string): string | null;
export function replacedChunks(a: string, b: string): { from: string; to: string }[];
export function createLearner(input: { read: (handle: number) => Promise<string | null>; log?: (m: string) => void;
  settings: () => { enabled: boolean; complete: Complete }; promote: (term: string, source: 'edit') => boolean }):
  { watch(w: { handle: number; inserted: string; before: string; after: string }): void; tick(): Promise<void> };

export const AUTO_HEADER: string;
export function splitVocabulary(text: string): { manualText: string; manual: string[]; auto: string[] };
export function plausibleTerm(term: string): boolean;
export interface VocabStore { loadState(): unknown; saveState(state: unknown): void; readVocab(): string; writeVocab(text: string): void }
export function createVocabAuto(input: { log?: (m: string) => void; store: VocabStore;
  settings: () => { enabled?: boolean; max?: number; maxAuto?: number; minSightings?: number; complete?: Complete | null } }): {
  promote(word: string, source: 'edit' | 'heard' | 'screen', now?: number): boolean;
  observe(terms: string[], now?: number): void;
  noteHits(text: string, now?: number): void;
  promoteHeard(text: string, now?: number): void;
  afterSegment(input: { screen?: string; text?: string }, now?: number): Promise<void>;
};

export class AudioTurnDetector {
  readonly speaking: boolean;
  lastVoiced: boolean;
  shortBlips: number;
  push(samples: Int16Array, startMs: number): { startMs: number; endMs: number } | null;
  finish(): { startMs: number; endMs: number } | null;
}
export function isSpeech(text: string): boolean;
export function onlyFiller(text: string): boolean;
export function withSpacing(text: string): string;

export const PROVIDERS: string[];
export const DEFAULT_MODELS: Record<string, string>;
export const PROVIDER_NAMES: Record<string, string>;
export const DEFAULT_URLS: Record<string, string>;
export function ownKeyService(input: { provider?: string; model?: string; apiKey?: string; jevKey?: string; jevModel?: string; timeoutMs?: number; urls?: Record<string, string> }):
  { model: string; complete: Complete | null; jev: Jev | null };
export const CORE_VERSION: string;
