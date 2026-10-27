export type ConnectParsedOptions = Readonly<{
  profileId: string;
  paste: boolean;
  device: boolean;
  noOpen: boolean;
  timeoutSeconds: number | null;
  setupToken: boolean;
  oauth: boolean;
  apiKey: boolean;
  token: boolean;
  import?: boolean;
  source?: string | null;
}>;

export function parseConnectArgs(args: ReadonlyArray<string>): Readonly<{
  includeExperimental: boolean;
  subcommand: string | null;
  options: ConnectParsedOptions;
}> {
  const includeExperimental = args.includes('--all') || args.includes('--experimental');
  const paste = args.includes('--paste');
  const device = args.includes('--device');
  const noOpen = args.includes('--no-open');
  const setupToken = args.includes('--setup-token') || args.includes('--setup_token');
  const oauth = args.includes('--oauth');
  const apiKey = args.includes('--api-key') || args.includes('--api_key');
  const token = args.includes('--token');
  const nativeImport = args.includes('--import');
  const sourceFlagIdx = args.findIndex((a) => a === '--source');
  const source = sourceFlagIdx !== -1 ? String(args[sourceFlagIdx + 1] ?? '').trim() : '';
  if (sourceFlagIdx !== -1 && (!source || source.startsWith('--'))) throw new Error('--source requires a source id');
  if (source && !nativeImport) throw new Error('--source requires --import');
  if (nativeImport && (paste || device || noOpen || setupToken || oauth || apiKey || token || args.includes('--timeout'))) throw new Error('--import cannot be combined with interactive authentication options');

  const profileFlagIdx = args.findIndex((a) => a === '--profile');
  const profileId = profileFlagIdx !== -1 ? String(args[profileFlagIdx + 1] ?? '').trim() : '';

  const timeoutFlagIdx = args.findIndex((a) => a === '--timeout');
  const timeoutRaw = timeoutFlagIdx !== -1 ? String(args[timeoutFlagIdx + 1] ?? '').trim() : '';
  const timeoutSeconds = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : NaN;
  const timeoutSecondsValue = Number.isFinite(timeoutSeconds) ? Math.max(1, Math.trunc(timeoutSeconds)) : null;

  const knownFlags = new Set([
    '--all',
    '--experimental',
    '--paste',
    '--device',
    '--no-open',
    '--setup-token',
    '--setup_token',
    '--oauth',
    '--api-key',
    '--api_key',
    '--token',
    '--profile',
    '--timeout',
    '--import',
    '--source',
  ]);
  const valuesConsumedByFlags = new Set<number>([
    profileFlagIdx !== -1 ? profileFlagIdx + 1 : -1,
    timeoutFlagIdx !== -1 ? timeoutFlagIdx + 1 : -1,
    sourceFlagIdx !== -1 ? sourceFlagIdx + 1 : -1,
  ]);

  const positional = args
    .filter((_a, idx) => !valuesConsumedByFlags.has(idx))
    .filter((a) => !knownFlags.has(a))
    .filter((a) => !a.startsWith('--'));

  const subcommand = positional[0] ?? null;
  return {
    includeExperimental,
    subcommand,
    options: {
      profileId: profileId || 'default',
      paste,
      device,
      noOpen,
      timeoutSeconds: timeoutSecondsValue,
      setupToken,
      oauth,
      apiKey,
      token,
      import: nativeImport,
      source: source || null,
    },
  };
}
