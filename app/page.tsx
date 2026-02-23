"use client";

import { useEffect, useMemo, useState } from "react";

type Player = { id: string; name: string };
type Match = { court: number; teamA: Player[]; teamB: Player[] };
type MatchResult = { scoreA: number | ""; scoreB: number | "" };

type SavedRound = {
  id: string;
  createdAt: number;
  courts: number;
  matches: Match[];
  results: Record<number, { scoreA: number; scoreB: number }>;
};

type PersistedStateV3 = {
  version: 3;
  tournamentName: string;

  setupDone: boolean;
  targetRounds: number;

  // NEW
  extraMode: boolean;

  manualEnded?: boolean;

  players: Player[];
  courts: number;

  matches: Match[];
  results: Record<number, MatchResult>;
  savedRounds: SavedRound[];
};

const STORAGE_KEY = "americano_app_state_v3";

function fmtTime(ts: number) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function makeKey(a: string, b: string) {
  return a < b ? `${a}__${b}` : `${b}__${a}`;
}

// --- Coverage stats (partner/opponent) from history ---
function computeStats(players: Player[], savedRounds: SavedRound[]) {
  const gamesPlayed: Record<string, number> = {};
  const partnerCount: Record<string, number> = {};
  const opponentCount: Record<string, number> = {};

  players.forEach((p) => (gamesPlayed[p.id] = 0));

  for (const round of savedRounds) {
    for (const m of round.matches) {
      const a1 = m.teamA[0].id;
      const a2 = m.teamA[1].id;
      const b1 = m.teamB[0].id;
      const b2 = m.teamB[1].id;

      gamesPlayed[a1] += 1;
      gamesPlayed[a2] += 1;
      gamesPlayed[b1] += 1;
      gamesPlayed[b2] += 1;

      const pa = makeKey(a1, a2);
      const pb = makeKey(b1, b2);
      partnerCount[pa] = (partnerCount[pa] ?? 0) + 1;
      partnerCount[pb] = (partnerCount[pb] ?? 0) + 1;

      const pairs: [string, string][] = [
        [a1, b1],
        [a1, b2],
        [a2, b1],
        [a2, b2],
      ];
      for (const [x, y] of pairs) {
        const k = makeKey(x, y);
        opponentCount[k] = (opponentCount[k] ?? 0) + 1;
      }
    }
  }

  return { gamesPlayed, partnerCount, opponentCount };
}

// --- Partner-Coverage helper ---
function partnerCoverage(players: Player[], savedRounds: SavedRound[]) {
  const n = players.length;
  if (n <= 1) return { complete: true, percent: 100, missingPairs: 0, totalPairs: 0 };

  const totalPairs = (n * (n - 1)) / 2;
  const seenPairs = new Set<string>();

  for (const round of savedRounds) {
    for (const m of round.matches) {
      const a = makeKey(m.teamA[0].id, m.teamA[1].id);
      const b = makeKey(m.teamB[0].id, m.teamB[1].id);
      seenPairs.add(a);
      seenPairs.add(b);
    }
  }

  const done = seenPairs.size;
  const percent = Math.max(0, Math.min(100, Math.round((done / totalPairs) * 100)));
  const missingPairs = Math.max(0, totalPairs - done);
  return { complete: done >= totalPairs, percent, missingPairs, totalPairs };
}

// --- Recommended rounds for partner coverage (fair even with bench) ---
// Lower bound to see all unique partnerships, given courts limit and rotations.
function recommendRoundsPartner(playerCount: number, courts: number) {
  if (playerCount < 4) return 0;
  const c = Math.max(1, Math.min(courts, Math.floor(playerCount / 4) || 1));
  // ceil( n*(n-1) / (4*c) )
  const num = playerCount * (playerCount - 1);
  const den = 4 * c;
  return Math.max(1, Math.ceil(num / den));
}

// --- Fair round generator (uses partner/opponent penalties) ---
function generateFairRound(params: {
  players: Player[];
  courtsWanted: number;
  savedRounds: SavedRound[];
}) {
  const { players, courtsWanted, savedRounds } = params;

  const n = players.length;
  const possibleCourts = Math.floor(n / 4);
  const courts = Math.max(0, Math.min(courtsWanted, possibleCourts));
  const slots = courts * 4;

  const { gamesPlayed, partnerCount, opponentCount } = computeStats(players, savedRounds);

  // Bias to let low-games players play first (bench rotation fairness)
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const byGames = shuffled.sort(
    (a, b) => (gamesPlayed[a.id] ?? 0) - (gamesPlayed[b.id] ?? 0)
  );

  const active = byGames.slice(0, slots);
  const bench = byGames.slice(slots);

  const remaining = [...active];

  const partner = (x: string, y: string) => partnerCount[makeKey(x, y)] ?? 0;
  const opp = (x: string, y: string) => opponentCount[makeKey(x, y)] ?? 0;
  const gp = (x: string) => gamesPlayed[x] ?? 0;

  function matchScore(a: Player, b: Player, c: Player, d: Player) {
    // Partner repeats hurt most (partner coverage goal)
    const partnerPenalty = 14 * partner(a.id, b.id) + 14 * partner(c.id, d.id);

    // Opponent repeats mild penalty (still adds variety)
    const opponentPenalty =
      3 *
      (opp(a.id, c.id) +
        opp(a.id, d.id) +
        opp(b.id, c.id) +
        opp(b.id, d.id));

    // Small bonus to include low-games players sooner
    const playtimeBonus = -0.25 * (gp(a.id) + gp(b.id) + gp(c.id) + gp(d.id));

    return partnerPenalty + opponentPenalty + playtimeBonus;
  }

  function bestSplitForFour(p: Player, q: Player, r: Player, s: Player) {
    const options = [
      { a: p, b: q, c: r, d: s, score: matchScore(p, q, r, s) },
      { a: p, b: r, c: q, d: s, score: matchScore(p, r, q, s) },
      { a: p, b: s, c: q, d: r, score: matchScore(p, s, q, r) },
    ];
    options.sort((x, y) => x.score - y.score);
    return options[0];
  }

  const matches: Match[] = [];

  for (let court = 1; court <= courts; court++) {
    if (remaining.length < 4) break;

    let best:
      | {
          group: [Player, Player, Player, Player];
          split: ReturnType<typeof bestSplitForFour>;
          score: number;
        }
      | null = null;

    for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) {
        for (let k = j + 1; k < remaining.length; k++) {
          for (let l = k + 1; l < remaining.length; l++) {
            const p = remaining[i];
            const q = remaining[j];
            const r = remaining[k];
            const s = remaining[l];
            const split = bestSplitForFour(p, q, r, s);
            if (!best || split.score < best.score) {
              best = { group: [p, q, r, s], split, score: split.score };
            }
          }
        }
      }
    }

    if (!best) break;

    const chosenIds = new Set(best.group.map((x) => x.id));
    for (let idx = remaining.length - 1; idx >= 0; idx--) {
      if (chosenIds.has(remaining[idx].id)) remaining.splice(idx, 1);
    }

    matches.push({
      court,
      teamA: [best.split.a, best.split.b],
      teamB: [best.split.c, best.split.d],
    });
  }

  return { matches, bench };
}

// ---- EXPORT HELPERS ----
function buildFinalRankingText(params: {
  tournamentName: string;
  savedRounds: SavedRound[];
  totalRanking: { name: string; points: number }[];
  targetRounds: number;
  manualEnded: boolean;
  extraMode: boolean;
}) {
  const { tournamentName, savedRounds, totalRanking, targetRounds, manualEnded, extraMode } = params;
  const header = `🏆 ${tournamentName}\n`;
  const meta = manualEnded
    ? `Beendet (manuell) • Runden: ${savedRounds.length}\n`
    : extraMode
      ? `Extra-Modus • Runden: ${savedRounds.length} (Ziel war ${targetRounds})\n`
      : `Runden: ${Math.min(savedRounds.length, targetRounds)}/${targetRounds}\n`;

  const rankingLines = totalRanking.map((r, i) => `${i + 1}. ${r.name} — ${r.points}`);

  return `${header}${meta}\n📊 Final Ranking\n${rankingLines.join("\n")}\n`;
}

function buildFullReportText(params: {
  tournamentName: string;
  savedRounds: SavedRound[];
  totalRanking: { name: string; points: number }[];
  targetRounds: number;
  manualEnded: boolean;
  extraMode: boolean;
}) {
  const { tournamentName, savedRounds, totalRanking, targetRounds, manualEnded, extraMode } = params;

  const header = `🏆 ${tournamentName}\n`;
  const meta = manualEnded
    ? `Beendet (manuell) • Gespeicherte Runden: ${savedRounds.length}\n`
    : extraMode
      ? `Extra-Modus • Gespeicherte Runden: ${savedRounds.length} (Ziel war ${targetRounds})\n`
      : `Gespeicherte Runden: ${Math.min(savedRounds.length, targetRounds)}/${targetRounds}\n`;

  const roundsBlock =
    savedRounds.length === 0
      ? "Keine gespeicherten Runden.\n"
      : savedRounds
          .slice()
          .reverse()
          .map((round, idx) => {
            const roundNo = idx + 1;
            const time = fmtTime(round.createdAt);
            const matches = round.matches
              .map((m) => {
                const r = round.results[m.court];
                const a = `${m.teamA[0].name} & ${m.teamA[1].name}`;
                const b = `${m.teamB[0].name} & ${m.teamB[1].name}`;
                return `Court ${m.court}: ${a} (${r.scoreA}) vs ${b} (${r.scoreB})`;
              })
              .join("\n");
            return `\nRunde ${roundNo} (${time})\n${matches}`;
          })
          .join("\n");

  const rankingLines = totalRanking.map((r, i) => `${i + 1}. ${r.name} — ${r.points}`);

  return `${header}${meta}\n🗓️ Runden\n${roundsBlock}\n\n📊 Final Ranking\n${rankingLines.join("\n")}\n`;
}

export default function Home() {
  // Setup/Wizard state
  const [tournamentName, setTournamentName] = useState<string>("Mein Americano");
  const [setupDone, setSetupDone] = useState<boolean>(false);

  const [setupPlayerCount, setSetupPlayerCount] = useState<number>(8);
  const [setupNames, setSetupNames] = useState<string[]>(
    Array.from({ length: 8 }, () => "")
  );
  const [setupCourts, setSetupCourts] = useState<number>(2);
  const [targetRounds, setTargetRounds] = useState<number>(recommendRoundsPartner(8, 2));

  // Main app state
  const [name, setName] = useState("");
  const [players, setPlayers] = useState<Player[]>([]);
  const [courts, setCourts] = useState<number>(1);

  const [matches, setMatches] = useState<Match[]>([]);
  const [results, setResults] = useState<Record<number, MatchResult>>({});
  const [savedRounds, setSavedRounds] = useState<SavedRound[]>([]);
  const [manualEnded, setManualEnded] = useState<boolean>(false);

  // NEW
  const [extraMode, setExtraMode] = useState<boolean>(false);

  const [error, setError] = useState<string>("");
  const [toast, setToast] = useState<string>("");

  const [loadedFromStorage, setLoadedFromStorage] = useState(false);

  // --- LOAD once on mount ---
  useEffect(() => {
    // Backward compatibility: try old key too (if exists)
    const legacy = safeParse<any>(localStorage.getItem("americano_app_state_v2"));
    const parsed = safeParse<PersistedStateV3>(localStorage.getItem(STORAGE_KEY));

    if (parsed && parsed.version === 3) {
      setTournamentName(parsed.tournamentName ?? "Mein Americano");
      setSetupDone(parsed.setupDone ?? false);
      setTargetRounds(parsed.targetRounds ?? 0);

      setExtraMode(parsed.extraMode ?? false);

      setManualEnded(parsed.manualEnded ?? false);

      setPlayers(parsed.players ?? []);
      setCourts(parsed.courts ?? 1);

      setMatches(parsed.matches ?? []);
      setResults(parsed.results ?? {});
      setSavedRounds(parsed.savedRounds ?? []);
    } else if (legacy && legacy.version === 2) {
      // Migrate v2 -> v3
      setTournamentName(legacy.tournamentName ?? "Mein Americano");
      setSetupDone(legacy.setupDone ?? false);
      setTargetRounds(legacy.targetRounds ?? 0);

      setExtraMode(false);

      setManualEnded(legacy.manualEnded ?? false);

      setPlayers(legacy.players ?? []);
      setCourts(legacy.courts ?? 1);

      setMatches(legacy.matches ?? []);
      setResults(legacy.results ?? {});
      setSavedRounds(legacy.savedRounds ?? []);

      localStorage.removeItem("americano_app_state_v2");
    }

    setLoadedFromStorage(true);
  }, []);

  // --- SAVE whenever state changes ---
  useEffect(() => {
    if (!loadedFromStorage) return;
    const payload: PersistedStateV3 = {
      version: 3,
      tournamentName,
      setupDone,
      targetRounds,
      extraMode,
      manualEnded,
      players,
      courts,
      matches,
      results,
      savedRounds,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [
    loadedFromStorage,
    tournamentName,
    setupDone,
    targetRounds,
    extraMode,
    manualEnded,
    players,
    courts,
    matches,
    results,
    savedRounds,
  ]);

  // Toast auto-hide
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  // Keep setup fields consistent when player count changes
  useEffect(() => {
    setSetupNames((prev) => {
      const next = [...prev];
      if (setupPlayerCount > next.length) {
        for (let i = next.length; i < setupPlayerCount; i++) next.push("");
      } else if (setupPlayerCount < next.length) {
        next.length = setupPlayerCount;
      }
      return next;
    });
  }, [setupPlayerCount]);

  // Update recommended rounds when player count or courts change
  useEffect(() => {
    const rec = recommendRoundsPartner(setupPlayerCount, setupCourts);
    setTargetRounds((curr) => {
      // If user never touched rounds much, keep it aligned
      // but if they changed it significantly, don't fight them.
      // Simple rule: if curr equals previous recommendation (roughly),
      // update it; otherwise keep their value.
      // We'll just update if curr is 0 or curr is close to rec (±1).
      if (curr <= 0) return rec;
      if (Math.abs(curr - rec) <= 1) return rec;
      return curr;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupPlayerCount, setupCourts]);

  const maxCourtsPossible = Math.max(1, Math.floor(players.length / 4));
  const effectiveCourts = Math.min(Math.max(1, courts), maxCourtsPossible);

  const coverage = useMemo(() => partnerCoverage(players, savedRounds), [players, savedRounds]);

  const tournamentFinished =
    manualEnded || (!extraMode && targetRounds > 0 && savedRounds.length >= targetRounds);

  const sortedPlayers = useMemo(() => {
    return [...players].sort((a, b) => a.name.localeCompare(b.name, "de"));
  }, [players]);

  function resetAll() {
    setTournamentName("Mein Americano");
    setSetupDone(false);
    setTargetRounds(0);
    setManualEnded(false);
    setExtraMode(false);

    setPlayers([]);
    setCourts(1);
    setMatches([]);
    setResults({});
    setSavedRounds([]);
    setName("");
    setError("");
    setToast("");
    localStorage.removeItem(STORAGE_KEY);
  }

  function newTournamentFromCurrent() {
    setError("");
    setSetupPlayerCount(Math.max(4, players.length || 8));
    setSetupNames(players.length > 0 ? players.map((p) => p.name) : Array.from({ length: 8 }, () => ""));
    setSetupCourts(courts || 1);
    setTargetRounds(recommendRoundsPartner(Math.max(4, players.length || 8), courts || 1));
    setSavedRounds([]);
    setMatches([]);
    setResults({});
    setManualEnded(false);
    setExtraMode(false);
    setSetupDone(false);
  }

  // Players editing (after setup)
  const canAdd = name.trim().length >= 2;

  function addPlayer() {
    const trimmed = name.trim();
    if (trimmed.length < 2) return;
    setPlayers((prev) => [...prev, { id: crypto.randomUUID(), name: trimmed }]);
    setName("");
    setError("");
  }

  function removePlayer(id: string) {
    setPlayers((prev) => prev.filter((p) => p.id !== id));
    setError("");
  }

  function generateRoundFair() {
    setError("");

    if (tournamentFinished) {
      setError("Turnier ist beendet. Tippe auf „Extra-Runden spielen“ oder starte ein neues Turnier.");
      return;
    }

    if (players.length < 4) {
      setMatches([]);
      setResults({});
      setError("Du brauchst mindestens 4 Spieler für ein Match (2v2).");
      return;
    }

    const possible = Math.floor(players.length / 4);
    const usedCourts = Math.min(effectiveCourts, possible);

    const { matches: fairMatches } = generateFairRound({
      players,
      courtsWanted: usedCourts,
      savedRounds,
    });

    const newResults: Record<number, MatchResult> = {};
    for (const m of fairMatches) newResults[m.court] = { scoreA: "", scoreB: "" };

    setMatches(fairMatches);
    setResults(newResults);
  }

  const unusedPlayers = useMemo(() => {
    const usedIds = new Set<string>();
    matches.forEach((m) => {
      m.teamA.forEach((p) => usedIds.add(p.id));
      m.teamB.forEach((p) => usedIds.add(p.id));
    });
    return sortedPlayers.filter((p) => !usedIds.has(p.id));
  }, [matches, sortedPlayers]);

  function updateScore(court: number, side: "A" | "B", value: string) {
    const num = value === "" ? "" : Math.max(0, Number(value));
    setResults((prev) => ({
      ...prev,
      [court]: {
        scoreA: side === "A" ? num : prev[court]?.scoreA ?? "",
        scoreB: side === "B" ? num : prev[court]?.scoreB ?? "",
      },
    }));
  }

  function canSaveCurrentRound() {
    if (matches.length === 0) return false;
    return matches.every((m) => {
      const r = results[m.court];
      return r && r.scoreA !== "" && r.scoreB !== "";
    });
  }

  function saveRound() {
    setError("");

    if (tournamentFinished) {
      setError("Turnier ist beendet. Tippe auf „Extra-Runden spielen“ oder starte ein neues Turnier.");
      return;
    }

    if (matches.length === 0) {
      setError("Erst eine Runde generieren, dann speichern.");
      return;
    }
    if (!canSaveCurrentRound()) {
      setError("Bitte für alle Courts beide Punktzahlen eintragen, bevor du speicherst.");
      return;
    }

    const frozenResults: SavedRound["results"] = {};
    matches.forEach((m) => {
      const r = results[m.court]!;
      frozenResults[m.court] = { scoreA: Number(r.scoreA), scoreB: Number(r.scoreB) };
    });

    const round: SavedRound = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      courts: matches.length,
      matches,
      results: frozenResults,
    };

    setSavedRounds((prev) => [round, ...prev]);
    setMatches([]);
    setResults({});
  }

  function deleteLastRound() {
    setSavedRounds((prev) => prev.slice(1));
  }

  function endTournamentNow() {
    setError("");
    setManualEnded(true);
    setMatches([]);
    setResults({});
  }

  function resumeTournament() {
    setError("");
    setManualEnded(false);
  }

  function playExtraRounds() {
    setError("");
    setManualEnded(false);
    setExtraMode(true);
  }

  const totalRanking = useMemo(() => {
    const points: Record<string, number> = {};
    players.forEach((p) => (points[p.id] = 0));

    savedRounds.forEach((round) => {
      round.matches.forEach((m) => {
        const r = round.results[m.court];
        const a = r.scoreA;
        const b = r.scoreB;
        m.teamA.forEach((p) => (points[p.id] += a));
        m.teamB.forEach((p) => (points[p.id] += b));
      });
    });

    const rows = players.map((p) => ({
      id: p.id,
      name: p.name,
      points: points[p.id] ?? 0,
    }));

    rows.sort((x, y) => y.points - x.points || x.name.localeCompare(y.name, "de"));
    return rows;
  }, [players, savedRounds]);

  const currentRoundRanking = useMemo(() => {
    const points: Record<string, number> = {};
    players.forEach((p) => (points[p.id] = 0));

    matches.forEach((m) => {
      const r = results[m.court];
      if (!r || r.scoreA === "" || r.scoreB === "") return;
      const a = Number(r.scoreA);
      const b = Number(r.scoreB);
      m.teamA.forEach((p) => (points[p.id] += a));
      m.teamB.forEach((p) => (points[p.id] += b));
    });

    const rows = players.map((p) => ({
      id: p.id,
      name: p.name,
      points: points[p.id] ?? 0,
    }));

    rows.sort((x, y) => y.points - x.points || x.name.localeCompare(y.name, "de"));
    return rows;
  }, [matches, players, results]);

  const anyCurrentResultEntered = useMemo(() => {
    return matches.some((m) => {
      const r = results[m.court];
      return r && (r.scoreA !== "" || r.scoreB !== "");
    });
  }, [matches, results]);

  const roundsProgress = targetRounds > 0 ? `${Math.min(savedRounds.length, targetRounds)}/${targetRounds}` : `${savedRounds.length}`;

  async function copyToClipboard(text: string, okMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      setToast(okMessage);
    } catch {
      setError("Kopieren hat nicht funktioniert (Clipboard). Bitte im Browser erlauben.");
    }
  }

  function startTournamentFromSetup() {
    setError("");

    const tName = tournamentName.trim();
    const names = setupNames.map((n) => n.trim());

    if (tName.length < 2) {
      setError("Bitte einen Turniernamen eingeben.");
      return;
    }

    // Allow empty fields BUT then they must use Auto-Fill or fill manually
    if (names.some((n) => n.length === 0)) {
      setError("Bitte für alle Spieler:innen einen Namen eintragen (oder Auto-Fill nutzen).");
      return;
    }

    if (setupCourts < 1) {
      setError("Bitte mindestens 1 Court auswählen.");
      return;
    }

    const newPlayers: Player[] = names.map((n) => ({ id: crypto.randomUUID(), name: n }));
    const maxPossible = Math.max(1, Math.floor(newPlayers.length / 4));
    const fixedCourts = Math.min(setupCourts, maxPossible);

    setPlayers(newPlayers);
    setCourts(fixedCourts);
    setSavedRounds([]);
    setMatches([]);
    setResults({});
    setTargetRounds(targetRounds || recommendRoundsPartner(setupPlayerCount, fixedCourts));
    setManualEnded(false);
    setExtraMode(false);
    setSetupDone(true);
  }

  // --- UI: Setup Wizard ---
  if (!setupDone) {
    const possibleCourtsSetup = Math.max(1, Math.floor(setupPlayerCount / 4));
    const recommended = recommendRoundsPartner(setupPlayerCount, Math.min(setupCourts, possibleCourtsSetup));

    return (
      <main className="min-h-screen bg-gray-50 text-gray-900">
        <div className="mx-auto max-w-3xl px-4 py-10">
          <div className="flex items-end justify-between">
            <div>
              <h1 className="text-3xl font-bold">Americano Organizer</h1>
              <p className="mt-2 text-gray-600">
                Setup: Turniername → Spieler:innen → Courts → Runden.
              </p>
            </div>
            <button
              onClick={resetAll}
              className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50"
            >
              Reset
            </button>
          </div>

          {error && (
            <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {error}
            </div>
          )}

          <section className="mt-8 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
            <h2 className="text-lg font-semibold">1) Turnier</h2>
            <label className="mt-3 block text-sm text-gray-700">
              Turniername
              <input
                value={tournamentName}
                onChange={(e) => setTournamentName(e.target.value)}
                className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 outline-none focus:border-gray-400"
                placeholder="z.B. Padel Americano Freitag"
              />
            </label>
          </section>

          <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">2) Spieler:innen</h2>

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() =>
                    setSetupNames((prev) =>
                      prev.map((v, i) => (v.trim().length === 0 ? `Spieler ${i + 1}` : v))
                    )
                  }
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50"
                >
                  Auto-Fill
                </button>
                <button
                  onClick={() => setSetupNames((prev) => prev.map(() => ""))}
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50"
                >
                  Alle leeren
                </button>
              </div>
            </div>

            <label className="mt-3 block text-sm text-gray-700">
              Anzahl Spieler:innen
              <input
                type="number"
                min={4}
                value={setupPlayerCount}
                onChange={(e) => setSetupPlayerCount(Math.max(4, Number(e.target.value)))}
                className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 outline-none focus:border-gray-400"
              />
            </label>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {setupNames.map((val, idx) => (
                <label key={idx} className="text-sm text-gray-700">
                  Spieler {idx + 1}
                  <input
                    value={val}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSetupNames((prev) => {
                        const next = [...prev];
                        next[idx] = v;
                        return next;
                      });
                    }}
                    className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 outline-none focus:border-gray-400"
                    placeholder={`Name ${idx + 1}`}
                  />
                </label>
              ))}
            </div>

            <div className="mt-4 rounded-xl bg-gray-50 p-4 text-sm text-gray-700">
              <div className="font-semibold">Hinweis</div>
              Pro Court brauchst du <span className="font-semibold">4 Spieler</span> (2v2).
            </div>
          </section>

          <section className="mt-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
            <h2 className="text-lg font-semibold">3) Courts & Runden</h2>

            <label className="mt-3 block text-sm text-gray-700">
              Anzahl Courts (max. {possibleCourtsSetup})
              <input
                type="number"
                min={1}
                max={possibleCourtsSetup}
                value={setupCourts}
                onChange={(e) =>
                  setSetupCourts(Math.min(possibleCourtsSetup, Math.max(1, Number(e.target.value))))
                }
                className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 outline-none focus:border-gray-400"
              />
            </label>

            <label className="mt-4 block text-sm text-gray-700">
              Runden (Vorschlag: {recommended})
              <input
                type="number"
                min={1}
                value={targetRounds}
                onChange={(e) => setTargetRounds(Math.max(1, Number(e.target.value)))}
                className="mt-1 w-full rounded-xl border border-gray-300 bg-white px-3 py-2 outline-none focus:border-gray-400"
              />
            </label>

            <div className="mt-4 rounded-xl bg-gray-50 p-4 text-sm text-gray-700">
              <div className="font-semibold">Partner-Coverage (Padel)</div>
              <p className="mt-1">
                Ziel: möglichst jede Paarung (Partner) mindestens einmal.
                Der Vorschlag berücksichtigt Courts + Rotation (Pausen).
              </p>
            </div>

            <button
              onClick={startTournamentFromSetup}
              className="mt-5 w-full rounded-xl bg-black px-4 py-3 font-medium text-white shadow-sm hover:opacity-95"
            >
              Turnier starten
            </button>
          </section>
        </div>
      </main>
    );
  }

  // --- MAIN APP UI ---
  return (
    <main className="min-h-screen bg-gray-50 text-gray-900">
      <div className="mx-auto max-w-5xl px-4 py-10">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold">{tournamentName}</h1>
            <p className="mt-2 text-gray-600">
              Fortschritt: <span className="font-semibold">{roundsProgress}</span> · Courts:{" "}
              <span className="font-semibold">{effectiveCourts}</span> · Partner-Coverage:{" "}
              <span className="font-semibold">{coverage.percent}%</span>
              {extraMode ? <span className="ml-2 rounded-full bg-gray-100 px-2 py-1 text-xs">Extra</span> : null}
            </p>
          </div>

          <button
            onClick={resetAll}
            className="w-fit rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50"
          >
            Reset (alles löschen)
          </button>
        </div>

        {toast && (
          <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            {toast}
          </div>
        )}

        {/* Turnier beendet */}
        {tournamentFinished && (
          <div className="mt-6 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-lg font-semibold">🏁 Turnier beendet</div>
                <div className="mt-1 text-sm text-gray-600">
                  {manualEnded ? (
                    <>
                      Turnier wurde manuell beendet. Gespeichert:{" "}
                      <span className="font-semibold">{savedRounds.length}</span> Runde(n).
                    </>
                  ) : (
                    <>
                      Zielrunden erreicht: <span className="font-semibold">{targetRounds}</span>. Partner-Coverage:{" "}
                      <span className="font-semibold">{coverage.percent}%</span>.
                    </>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={playExtraRounds}
                  className="rounded-xl bg-black px-4 py-2 text-sm font-medium text-white shadow-sm hover:opacity-95"
                >
                  Extra-Runden spielen
                </button>

                {manualEnded && savedRounds.length < targetRounds && (
                  <button
                    onClick={resumeTournament}
                    className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50"
                  >
                    Weiter spielen
                  </button>
                )}

                <button
                  onClick={() =>
                    copyToClipboard(
                      buildFinalRankingText({
                        tournamentName,
                        savedRounds,
                        totalRanking: totalRanking.map((r) => ({ name: r.name, points: r.points })),
                        targetRounds,
                        manualEnded,
                        extraMode,
                      }),
                      "Final Ranking kopiert ✅"
                    )
                  }
                  className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50"
                >
                  Copy Final
                </button>

                <button
                  onClick={() =>
                    copyToClipboard(
                      buildFullReportText({
                        tournamentName,
                        savedRounds,
                        totalRanking: totalRanking.map((r) => ({ name: r.name, points: r.points })),
                        targetRounds,
                        manualEnded,
                        extraMode,
                      }),
                      "Turnier-Report kopiert ✅"
                    )
                  }
                  className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50"
                >
                  Copy Report
                </button>

                <button
                  onClick={newTournamentFromCurrent}
                  className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50"
                >
                  Neues Turnier
                </button>
              </div>
            </div>

            <div className="mt-4 overflow-hidden rounded-xl border border-gray-100">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 text-gray-700">
                  <tr>
                    <th className="px-4 py-3 font-semibold">#</th>
                    <th className="px-4 py-3 font-semibold">Spieler</th>
                    <th className="px-4 py-3 font-semibold">Punkte</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {totalRanking.map((row, idx) => (
                    <tr key={row.id} className="bg-white">
                      <td className="px-4 py-3 font-medium text-gray-700">{idx + 1}</td>
                      <td className="px-4 py-3 font-medium">{row.name}</td>
                      <td className="px-4 py-3 font-semibold">{row.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        )}

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {/* Players Card */}
          <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Spieler</h2>
              <div className="text-sm text-gray-600">
                Anzahl: <span className="font-semibold">{players.length}</span>
              </div>
            </div>

            <div className="mt-4 flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addPlayer();
                }}
                placeholder="Name hinzufügen"
                className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 outline-none focus:border-gray-400"
              />
              <button
                onClick={addPlayer}
                disabled={!canAdd}
                className="rounded-xl bg-black px-4 py-2 font-medium text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
              >
                Hinzufügen
              </button>
            </div>

            <ul className="mt-4 divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-100">
              {sortedPlayers.length === 0 ? (
                <li className="p-4 text-gray-600">Noch keine Spieler hinzugefügt.</li>
              ) : (
                sortedPlayers.map((p) => (
                  <li key={p.id} className="flex items-center justify-between p-4">
                    <span className="font-medium">{p.name}</span>
                    <button
                      onClick={() => removePlayer(p.id)}
                      className="rounded-lg border border-gray-200 px-3 py-1 text-sm hover:bg-gray-50"
                    >
                      Entfernen
                    </button>
                  </li>
                ))
              )}
            </ul>

            <div className="mt-4 rounded-xl bg-gray-50 p-4 text-sm text-gray-700">
              <div className="font-semibold">Partner-Coverage</div>
              <p className="mt-1">
                Aktuell: <span className="font-semibold">{coverage.percent}%</span>{" "}
                ({coverage.totalPairs - coverage.missingPairs}/{coverage.totalPairs} Paarungen).
              </p>
            </div>
          </section>

          {/* Round Card */}
          <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Aktuelle Runde</h2>
              <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
                Courts: {effectiveCourts}
              </span>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                onClick={generateRoundFair}
                disabled={tournamentFinished}
                className="h-[42px] rounded-xl bg-emerald-600 px-4 py-2 font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Neue Runde (fair)
              </button>

              <button
                onClick={saveRound}
                disabled={tournamentFinished || matches.length === 0 || !canSaveCurrentRound()}
                className="h-[42px] rounded-xl bg-black px-4 py-2 text-sm font-medium text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
              >
                Runde speichern
              </button>

              {savedRounds.length > 0 && (
                <button
                  onClick={deleteLastRound}
                  className="h-[42px] rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50"
                >
                  Letzte Runde löschen
                </button>
              )}

              {!tournamentFinished && (
                <button
                  onClick={endTournamentNow}
                  className="h-[42px] rounded-xl border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 shadow-sm hover:bg-red-50"
                >
                  Turnier beenden
                </button>
              )}

              <button
                onClick={() =>
                  copyToClipboard(
                    buildFinalRankingText({
                      tournamentName,
                      savedRounds,
                      totalRanking: totalRanking.map((r) => ({ name: r.name, points: r.points })),
                      targetRounds,
                      manualEnded,
                      extraMode,
                    }),
                    "Final Ranking kopiert ✅"
                  )
                }
                className="ml-auto h-[42px] rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50"
              >
                Copy Final
              </button>

              <button
                onClick={() =>
                  copyToClipboard(
                    buildFullReportText({
                      tournamentName,
                      savedRounds,
                      totalRanking: totalRanking.map((r) => ({ name: r.name, points: r.points })),
                      targetRounds,
                      manualEnded,
                      extraMode,
                    }),
                    "Turnier-Report kopiert ✅"
                  )
                }
                className="h-[42px] rounded-xl bg-black px-4 py-2 text-sm font-medium text-white shadow-sm hover:opacity-95"
              >
                Copy Report
              </button>
            </div>

            <div className="mt-5 space-y-3">
              {matches.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-700">
                  {tournamentFinished ? (
                    <span>
                      Turnier beendet. Tippe auf <span className="font-semibold">„Extra-Runden spielen“</span>.
                    </span>
                  ) : (
                    <span>
                      Keine aktive Runde. Klicke{" "}
                      <span className="font-semibold">„Neue Runde (fair)“</span>.
                    </span>
                  )}
                </div>
              ) : (
                matches.map((m) => {
                  const r = results[m.court] ?? { scoreA: "", scoreB: "" };
                  return (
                    <div
                      key={m.court}
                      className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
                    >
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-semibold text-gray-800">
                          Court {m.court}
                        </div>
                        <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-700">
                          2v2
                        </span>
                      </div>

                      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                        <div className="rounded-xl bg-gray-50 p-3">
                          <div className="text-xs font-semibold text-gray-600">Team A</div>
                          <div className="mt-1 font-medium">
                            {m.teamA[0].name} & {m.teamA[1].name}
                          </div>

                          <div className="mt-3 flex items-center gap-2">
                            <label className="text-xs font-semibold text-gray-600">
                              Punkte
                            </label>
                            <input
                              inputMode="numeric"
                              type="number"
                              min={0}
                              value={r.scoreA}
                              onChange={(e) =>
                                updateScore(m.court, "A", e.target.value)
                              }
                              className="w-24 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-gray-400"
                              placeholder="z.B. 21"
                            />
                          </div>
                        </div>

                        <div className="mx-auto text-sm font-semibold text-gray-500">
                          VS
                        </div>

                        <div className="rounded-xl bg-gray-50 p-3">
                          <div className="text-xs font-semibold text-gray-600">Team B</div>
                          <div className="mt-1 font-medium">
                            {m.teamB[0].name} & {m.teamB[1].name}
                          </div>

                          <div className="mt-3 flex items-center gap-2">
                            <label className="text-xs font-semibold text-gray-600">
                              Punkte
                            </label>
                            <input
                              inputMode="numeric"
                              type="number"
                              min={0}
                              value={r.scoreB}
                              onChange={(e) =>
                                updateScore(m.court, "B", e.target.value)
                              }
                              className="w-24 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-gray-400"
                              placeholder="z.B. 15"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {matches.length > 0 && unusedPlayers.length > 0 && (
              <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
                <div className="font-semibold">Pause (nicht eingeteilt)</div>
                <div className="mt-1">{unusedPlayers.map((p) => p.name).join(", ")}</div>
              </div>
            )}

            <div className="mt-5 rounded-2xl bg-white p-4 ring-1 ring-gray-200">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Rangliste (aktuelle Runde)</div>
                {!anyCurrentResultEntered && (
                  <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
                    Noch keine Ergebnisse
                  </span>
                )}
              </div>

              <div className="mt-3 overflow-hidden rounded-xl border border-gray-100">
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 text-gray-700">
                    <tr>
                      <th className="px-4 py-3 font-semibold">#</th>
                      <th className="px-4 py-3 font-semibold">Spieler</th>
                      <th className="px-4 py-3 font-semibold">Punkte</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {currentRoundRanking.map((row, idx) => (
                      <tr key={row.id} className="bg-white">
                        <td className="px-4 py-3 font-medium text-gray-700">{idx + 1}</td>
                        <td className="px-4 py-3 font-medium">{row.name}</td>
                        <td className="px-4 py-3 font-semibold">{row.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Gespeicherte Runden</h2>
                <p className="mt-1 text-sm text-gray-600">
                  Fairness basiert auf deinen gespeicherten Runden.
                </p>
              </div>
              <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
                {savedRounds.length} Runde(n)
              </span>
            </div>

            <div className="mt-4 space-y-3">
              {savedRounds.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-700">
                  Noch keine Runde gespeichert.
                </div>
              ) : (
                savedRounds.map((round) => (
                  <div key={round.id} className="rounded-2xl border border-gray-200 p-4">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-semibold">
                        Runde {fmtTime(round.createdAt)}
                      </div>
                      <div className="text-xs text-gray-600">{round.courts} Court(s)</div>
                    </div>

                    <div className="mt-3 space-y-2 text-sm">
                      {round.matches.map((m) => {
                        const r = round.results[m.court];
                        return (
                          <div key={m.court} className="rounded-xl bg-gray-50 p-3">
                            <div className="flex items-center justify-between">
                              <div className="text-xs font-semibold text-gray-600">
                                Court {m.court}
                              </div>
                              <div className="text-xs font-semibold text-gray-700">
                                {r.scoreA}:{r.scoreB}
                              </div>
                            </div>
                            <div className="mt-1 font-medium">
                              {m.teamA[0].name} & {m.teamA[1].name}{" "}
                              <span className="text-gray-500">vs</span>{" "}
                              {m.teamB[0].name} & {m.teamB[1].name}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
            <div>
              <h2 className="text-lg font-semibold">Gesamt-Rangliste</h2>
              <p className="mt-1 text-sm text-gray-600">
                Summe aus allen gespeicherten Runden (Americano-Logik).
              </p>
            </div>

            <div className="mt-4 overflow-hidden rounded-xl border border-gray-100">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 text-gray-700">
                  <tr>
                    <th className="px-4 py-3 font-semibold">#</th>
                    <th className="px-4 py-3 font-semibold">Spieler</th>
                    <th className="px-4 py-3 font-semibold">Punkte</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {totalRanking.map((row, idx) => (
                    <tr key={row.id} className="bg-white">
                      <td className="px-4 py-3 font-medium text-gray-700">{idx + 1}</td>
                      <td className="px-4 py-3 font-medium">{row.name}</td>
                      <td className="px-4 py-3 font-semibold">{row.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 rounded-xl bg-gray-50 p-4 text-sm text-gray-700">
              <div className="font-semibold">Tipp</div>
              <p className="mt-1">
                Wenn du nach Ende weiter spielen willst: <span className="font-semibold">Extra-Runden spielen</span>.
              </p>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}