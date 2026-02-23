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

type PersistedStateV4 = {
  version: 4;

  tournamentName: string;
  setupDone: boolean;

  players: Player[];
  courts: number;
  targetRounds: number;

  manualEnded: boolean;
  extraMode: boolean;

  matches: Match[];
  results: Record<number, MatchResult>;

  savedRounds: SavedRound[];

  activeTab: "play" | "ranking" | "history";
};

const STORAGE_KEY = "americano_app_state_v4";

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

function fmtTime(ts: number) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function partnerCoverage(players: Player[], savedRounds: SavedRound[]) {
  const n = players.length;
  if (n <= 1) return { complete: true, percent: 100, missingPairs: 0, totalPairs: 0 };

  const totalPairs = (n * (n - 1)) / 2;
  const seenPairs = new Set<string>();

  for (const round of savedRounds) {
    for (const m of round.matches) {
      seenPairs.add(makeKey(m.teamA[0].id, m.teamA[1].id));
      seenPairs.add(makeKey(m.teamB[0].id, m.teamB[1].id));
    }
  }

  const done = seenPairs.size;
  const percent = Math.max(0, Math.min(100, Math.round((done / totalPairs) * 100)));
  const missingPairs = Math.max(0, totalPairs - done);
  return { complete: done >= totalPairs, percent, missingPairs, totalPairs };
}

function recommendRoundsPartner(playerCount: number, courts: number) {
  if (playerCount < 4) return 0;
  const c = Math.max(1, Math.min(courts, Math.floor(playerCount / 4) || 1));
  const num = playerCount * (playerCount - 1);
  const den = 4 * c;
  return Math.max(1, Math.ceil(num / den));
}

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

function generateFairRound(params: { players: Player[]; courtsWanted: number; savedRounds: SavedRound[] }) {
  const { players, courtsWanted, savedRounds } = params;

  const n = players.length;
  const possibleCourts = Math.floor(n / 4);
  const courts = Math.max(0, Math.min(courtsWanted, possibleCourts));
  const slots = courts * 4;

  const { gamesPlayed, partnerCount, opponentCount } = computeStats(players, savedRounds);

  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const byGames = shuffled.sort((a, b) => (gamesPlayed[a.id] ?? 0) - (gamesPlayed[b.id] ?? 0));

  const active = byGames.slice(0, slots);

  const remaining = [...active];

  const partner = (x: string, y: string) => partnerCount[makeKey(x, y)] ?? 0;
  const opp = (x: string, y: string) => opponentCount[makeKey(x, y)] ?? 0;
  const gp = (x: string) => gamesPlayed[x] ?? 0;

  function matchScore(a: Player, b: Player, c: Player, d: Player) {
    const partnerPenalty = 14 * partner(a.id, b.id) + 14 * partner(c.id, d.id);
    const opponentPenalty =
      3 * (opp(a.id, c.id) + opp(a.id, d.id) + opp(b.id, c.id) + opp(b.id, d.id));
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
      | { group: [Player, Player, Player, Player]; split: ReturnType<typeof bestSplitForFour>; score: number }
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
            if (!best || split.score < best.score) best = { group: [p, q, r, s], split, score: split.score };
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

  const bench = byGames.slice(slots);

  return { matches, bench };
}

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

function clampInt(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function PageShell(props: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  bottomBar?: React.ReactNode;
  topRight?: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-gray-50 text-gray-900">
      <div className="mx-auto max-w-3xl px-4 pb-28 pt-8">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{props.title}</h1>
            {props.subtitle ? <p className="mt-1 text-sm text-gray-600">{props.subtitle}</p> : null}
          </div>
          {props.topRight}
        </div>

        <div className="mt-6">{props.children}</div>
      </div>

      {props.bottomBar ? (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-gray-200 bg-white/95 backdrop-blur">
          <div className="mx-auto max-w-3xl px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
            {props.bottomBar}
          </div>
        </div>
      ) : null}
    </main>
  );
}

function Segmented(props: {
  value: "play" | "ranking" | "history";
  onChange: (v: "play" | "ranking" | "history") => void;
}) {
  const Btn = (p: { v: "play" | "ranking" | "history"; label: string }) => (
    <button
      onClick={() => props.onChange(p.v)}
      className={[
        "flex-1 rounded-xl px-3 py-2 text-sm font-semibold",
        props.value === p.v ? "bg-black text-white" : "bg-gray-100 text-gray-800 hover:bg-gray-200",
      ].join(" ")}
    >
      {p.label}
    </button>
  );

  return (
    <div className="grid grid-cols-3 gap-2">
      <Btn v="play" label="Play" />
      <Btn v="ranking" label="Ranking" />
      <Btn v="history" label="History" />
    </div>
  );
}

function ScorePill(props: {
  label: string;
  value: number | "";
  onChange: (newVal: number | "") => void;
}) {
  const v = props.value === "" ? 0 : Number(props.value);

  const bump = (delta: number) => {
    const next = Math.max(0, v + delta);
    props.onChange(next);
  };

  return (
    <div className="rounded-2xl bg-gray-50 p-3 ring-1 ring-gray-200">
      <div className="text-xs font-semibold text-gray-600">{props.label}</div>

      <div className="mt-2 flex items-center justify-between gap-3">
        <button
          onClick={() => bump(-1)}
          className="h-11 w-11 rounded-xl bg-white text-lg font-bold ring-1 ring-gray-200 hover:bg-gray-100"
        >
          −
        </button>

        <div className="flex items-center gap-2">
          <input
            inputMode="numeric"
            type="number"
            min={0}
            value={props.value}
            onChange={(e) => props.onChange(e.target.value === "" ? "" : Math.max(0, Number(e.target.value)))}
            className="w-20 rounded-xl border border-gray-300 bg-white px-3 py-2 text-center text-lg font-bold outline-none focus:border-gray-400"
            placeholder="0"
          />
        </div>

        <button
          onClick={() => bump(+1)}
          className="h-11 w-11 rounded-xl bg-white text-lg font-bold ring-1 ring-gray-200 hover:bg-gray-100"
        >
          +
        </button>
      </div>

      <div className="mt-2 grid grid-cols-4 gap-2">
        {[+5, +10, +15, 0].map((x) =>
          x === 0 ? (
            <button
              key="reset"
              onClick={() => props.onChange(0)}
              className="rounded-xl bg-white px-2 py-2 text-xs font-semibold text-gray-800 ring-1 ring-gray-200 hover:bg-gray-100"
            >
              Reset
            </button>
          ) : (
            <button
              key={x}
              onClick={() => bump(x)}
              className="rounded-xl bg-white px-2 py-2 text-xs font-semibold text-gray-800 ring-1 ring-gray-200 hover:bg-gray-100"
            >
              +{x}
            </button>
          )
        )}
      </div>
    </div>
  );
}

export default function Home() {
  // Setup
  const [setupDone, setSetupDone] = useState(false);
  const [tournamentName, setTournamentName] = useState("Mein Americano");

  // ✅ FIX: Text-State fürs mobile-friendly Tippen
  const [setupPlayerCount, setSetupPlayerCount] = useState(8);
  const [setupPlayerCountText, setSetupPlayerCountText] = useState("8");

  const [setupNames, setSetupNames] = useState<string[]>(Array.from({ length: 8 }, () => ""));
  const [setupCourts, setSetupCourts] = useState(2);
  const [targetRounds, setTargetRounds] = useState(recommendRoundsPartner(8, 2));

  // Tournament
  const [players, setPlayers] = useState<Player[]>([]);
  const [courts, setCourts] = useState(1);

  const [matches, setMatches] = useState<Match[]>([]);
  const [results, setResults] = useState<Record<number, MatchResult>>({});
  const [savedRounds, setSavedRounds] = useState<SavedRound[]>([]);

  const [manualEnded, setManualEnded] = useState(false);
  const [extraMode, setExtraMode] = useState(false);

  // UI
  const [activeTab, setActiveTab] = useState<"play" | "ranking" | "history">("play");
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  // Load
  useEffect(() => {
    const parsed = safeParse<PersistedStateV4>(localStorage.getItem(STORAGE_KEY));
    if (parsed && parsed.version === 4) {
      setTournamentName(parsed.tournamentName ?? "Mein Americano");
      setSetupDone(parsed.setupDone ?? false);

      setPlayers(parsed.players ?? []);
      setCourts(parsed.courts ?? 1);
      setTargetRounds(parsed.targetRounds ?? 0);

      setManualEnded(parsed.manualEnded ?? false);
      setExtraMode(parsed.extraMode ?? false);

      setMatches(parsed.matches ?? []);
      setResults(parsed.results ?? {});
      setSavedRounds(parsed.savedRounds ?? []);

      setActiveTab(parsed.activeTab ?? "play");
    }
    setLoaded(true);
  }, []);

  // Save
  useEffect(() => {
    if (!loaded) return;
    const payload: PersistedStateV4 = {
      version: 4,
      tournamentName,
      setupDone,
      players,
      courts,
      targetRounds,
      manualEnded,
      extraMode,
      matches,
      results,
      savedRounds,
      activeTab,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [
    loaded,
    tournamentName,
    setupDone,
    players,
    courts,
    targetRounds,
    manualEnded,
    extraMode,
    matches,
    results,
    savedRounds,
    activeTab,
  ]);

  // Toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  // Setup names array size
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

  // Update recommended rounds when player count/courts change
  useEffect(() => {
    const possibleCourtsSetup = Math.max(1, Math.floor(setupPlayerCount / 4));
    const fixedCourts = clampInt(setupCourts, 1, possibleCourtsSetup);
    const rec = recommendRoundsPartner(setupPlayerCount, fixedCourts);
    setTargetRounds((curr) => {
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

  const roundsProgress =
    targetRounds > 0 ? `${Math.min(savedRounds.length, targetRounds)}/${targetRounds}` : `${savedRounds.length}`;

  const sortedPlayers = useMemo(() => [...players].sort((a, b) => a.name.localeCompare(b.name, "de")), [players]);

  const unusedPlayers = useMemo(() => {
    const usedIds = new Set<string>();
    matches.forEach((m) => {
      m.teamA.forEach((p) => usedIds.add(p.id));
      m.teamB.forEach((p) => usedIds.add(p.id));
    });
    return sortedPlayers.filter((p) => !usedIds.has(p.id));
  }, [matches, sortedPlayers]);

  const totalRanking = useMemo(() => {
    const points: Record<string, number> = {};
    players.forEach((p) => (points[p.id] = 0));

    savedRounds.forEach((round) => {
      round.matches.forEach((m) => {
        const r = round.results[m.court];
        m.teamA.forEach((p) => (points[p.id] += r.scoreA));
        m.teamB.forEach((p) => (points[p.id] += r.scoreB));
      });
    });

    const rows = players.map((p) => ({ id: p.id, name: p.name, points: points[p.id] ?? 0 }));
    rows.sort((x, y) => y.points - x.points || x.name.localeCompare(y.name, "de"));
    return rows;
  }, [players, savedRounds]);

  const currentRoundRanking = useMemo(() => {
    const points: Record<string, number> = {};
    players.forEach((p) => (points[p.id] = 0));

    matches.forEach((m) => {
      const r = results[m.court];
      if (!r || r.scoreA === "" || r.scoreB === "") return;
      m.teamA.forEach((p) => (points[p.id] += Number(r.scoreA)));
      m.teamB.forEach((p) => (points[p.id] += Number(r.scoreB)));
    });

    const rows = players.map((p) => ({ id: p.id, name: p.name, points: points[p.id] ?? 0 }));
    rows.sort((x, y) => y.points - x.points || x.name.localeCompare(y.name, "de"));
    return rows;
  }, [players, matches, results]);

  const canSaveCurrentRound = useMemo(() => {
    if (matches.length === 0) return false;
    return matches.every((m) => {
      const r = results[m.court];
      return r && r.scoreA !== "" && r.scoreB !== "";
    });
  }, [matches, results]);

  async function copyToClipboard(text: string, okMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      setToast(okMessage);
    } catch {
      setError("Kopieren hat nicht funktioniert. Bitte Clipboard erlauben.");
    }
  }

  function resetAll() {
    localStorage.removeItem(STORAGE_KEY);

    setSetupDone(false);
    setTournamentName("Mein Americano");

    setSetupPlayerCount(8);
    setSetupPlayerCountText("8");
    setSetupNames(Array.from({ length: 8 }, () => ""));
    setSetupCourts(2);
    setTargetRounds(recommendRoundsPartner(8, 2));

    setPlayers([]);
    setCourts(1);

    setMatches([]);
    setResults({});
    setSavedRounds([]);

    setManualEnded(false);
    setExtraMode(false);

    setActiveTab("play");
    setToast("");
    setError("");
  }

  function startTournamentFromSetup() {
    setError("");

    // ✅ FIX: finalCount aus Text ableiten + validieren
    const rawCount = Number(setupPlayerCountText);
    const finalCount = Number.isFinite(rawCount) && rawCount > 0 ? Math.max(4, rawCount) : 8;

    // sync states
    if (finalCount !== setupPlayerCount) setSetupPlayerCount(finalCount);
    if (String(finalCount) !== setupPlayerCountText) setSetupPlayerCountText(String(finalCount));

    const tName = tournamentName.trim();
    const names = setupNames.slice(0, finalCount).map((n) => n.trim());

    if (tName.length < 2) return setError("Bitte einen Turniernamen eingeben.");
    if (finalCount < 4) return setError("Mindestens 4 Spieler:innen.");

    if (names.length !== finalCount) return setError("Spieler:innen Anzahl passt nicht. Tippe kurz ins Feld und raus.");
    if (names.some((n) => n.length === 0)) return setError("Bitte alle Namen eintragen (oder Auto-Fill nutzen).");

    const newPlayers: Player[] = names.map((n) => ({ id: crypto.randomUUID(), name: n }));
    const maxPossible = Math.max(1, Math.floor(newPlayers.length / 4));
    const fixedCourts = clampInt(setupCourts, 1, maxPossible);

    setPlayers(newPlayers);
    setCourts(fixedCourts);

    const rec = recommendRoundsPartner(newPlayers.length, fixedCourts);
    setTargetRounds(targetRounds || rec);

    setMatches([]);
    setResults({});
    setSavedRounds([]);

    setManualEnded(false);
    setExtraMode(false);

    setSetupDone(true);
    setActiveTab("play");
  }

  function generateRoundFair() {
    setError("");

    if (tournamentFinished) {
      setError("Turnier beendet. Tippe auf „Extra-Runden spielen“ oder starte ein neues Turnier.");
      return;
    }

    if (players.length < 4) {
      setError("Mindestens 4 Spieler:innen nötig.");
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
    for (const m of fairMatches) newResults[m.court] = { scoreA: 0, scoreB: 0 };

    setMatches(fairMatches);
    setResults(newResults);
    setActiveTab("play");
  }

  function updateScore(court: number, side: "A" | "B", newVal: number | "") {
    setResults((prev) => ({
      ...prev,
      [court]: {
        scoreA: side === "A" ? newVal : prev[court]?.scoreA ?? 0,
        scoreB: side === "B" ? newVal : prev[court]?.scoreB ?? 0,
      },
    }));
  }

  function saveRound() {
    setError("");

    if (tournamentFinished) {
      setError("Turnier beendet. Tippe auf „Extra-Runden spielen“ oder starte ein neues Turnier.");
      return;
    }

    if (!canSaveCurrentRound) {
      setError("Bitte alle Scores eintragen.");
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
    setToast("Runde gespeichert ✅");
  }

  function deleteLastRound() {
    setSavedRounds((prev) => prev.slice(1));
    setToast("Letzte Runde gelöscht ✅");
  }

  function endTournamentNow() {
    setManualEnded(true);
    setMatches([]);
    setResults({});
    setActiveTab("ranking");
  }

  function playExtraRounds() {
    setManualEnded(false);
    setExtraMode(true);
    setActiveTab("play");
    setToast("Extra-Modus aktiviert ✅");
  }

  // ------------- SETUP SCREEN -------------
  if (!setupDone) {
    const possibleCourtsSetup = Math.max(1, Math.floor(setupPlayerCount / 4));
    const fixedCourts = clampInt(setupCourts, 1, possibleCourtsSetup);
    const rec = recommendRoundsPartner(setupPlayerCount, fixedCourts);

    return (
      <PageShell
        title="Americano Organizer"
        subtitle="Setup → Start → Spielen"
        topRight={
          <button
            onClick={resetAll}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-semibold shadow-sm hover:bg-gray-50"
          >
            Reset
          </button>
        }
      >
        {error ? (
          <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        <div className="space-y-5">
          <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
            <div className="text-sm font-semibold text-gray-800">Turniername</div>
            <input
              value={tournamentName}
              onChange={(e) => setTournamentName(e.target.value)}
              className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-3 text-base outline-none focus:border-gray-400"
              placeholder="z.B. Padel Americano Freitag"
            />
          </section>

          <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-gray-800">Spieler:innen</div>
                <div className="mt-1 text-xs text-gray-600">Leere Felder, Auto-Fill, Easy Mobile Edit.</div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() =>
                    setSetupNames((prev) =>
                      prev.map((v, i) => (v.trim().length === 0 ? `Spieler ${i + 1}` : v))
                    )
                  }
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-semibold shadow-sm hover:bg-gray-50"
                >
                  Auto-Fill
                </button>
                <button
                  onClick={() => setSetupNames((prev) => prev.map(() => ""))}
                  className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-semibold shadow-sm hover:bg-gray-50"
                >
                  Leeren
                </button>
              </div>
            </div>

            <div className="mt-4">
              <label className="text-sm font-semibold text-gray-700">Anzahl</label>

              {/* ✅ FIX: freies Tippen (auch leer), Validation erst onBlur */}
              <input
                inputMode="numeric"
                pattern="[0-9]*"
                value={setupPlayerCountText}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => {
                  const raw = e.target.value;
                  const digitsOnly = raw.replace(/[^\d]/g, "");
                  setSetupPlayerCountText(digitsOnly);
                }}
                onBlur={() => {
                  const n = Number(setupPlayerCountText);
                  const fixed = Number.isFinite(n) && n > 0 ? Math.max(4, n) : 8;
                  setSetupPlayerCount(fixed);
                  setSetupPlayerCountText(String(fixed));
                }}
                className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-3 text-base outline-none focus:border-gray-400"
                placeholder="z.B. 6"
              />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {setupNames.map((val, idx) => (
                <label key={idx} className="text-sm font-semibold text-gray-700">
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
                    className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-3 text-base outline-none focus:border-gray-400"
                    placeholder={`Name ${idx + 1}`}
                  />
                </label>
              ))}
            </div>
          </section>

          <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
            <div className="text-sm font-semibold text-gray-800">Courts & Runden</div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-sm font-semibold text-gray-700">Courts (max. {possibleCourtsSetup})</label>
                <input
                  type="number"
                  min={1}
                  max={possibleCourtsSetup}
                  value={setupCourts}
                  onChange={(e) => setSetupCourts(clampInt(Number(e.target.value), 1, possibleCourtsSetup))}
                  className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-3 text-base outline-none focus:border-gray-400"
                />
              </div>
              <div>
                <label className="text-sm font-semibold text-gray-700">Runden (Vorschlag: {rec})</label>
                <input
                  type="number"
                  min={1}
                  value={targetRounds}
                  onChange={(e) => setTargetRounds(Math.max(1, Number(e.target.value)))}
                  className="mt-2 w-full rounded-xl border border-gray-300 bg-white px-3 py-3 text-base outline-none focus:border-gray-400"
                />
              </div>
            </div>

            <div className="mt-4 rounded-2xl bg-gray-50 p-4 text-sm text-gray-700 ring-1 ring-gray-200">
              <div className="font-semibold">Padel-Logik: Partner-Coverage</div>
              <div className="mt-1">
                Ziel: möglichst jede Paarung (Partner) mindestens einmal. Runden-Vorschlag ist ein fairer Richtwert.
              </div>
            </div>

            <button
              onClick={startTournamentFromSetup}
              className="mt-5 w-full rounded-2xl bg-black px-4 py-4 text-base font-semibold text-white shadow-sm hover:opacity-95"
            >
              Turnier starten
            </button>
          </section>
        </div>
      </PageShell>
    );
  }

  // ------------- APP SHELL (Play/Ranking/History) -------------

  const headerSubtitle = `Runde ${roundsProgress} • Courts ${effectiveCourts} • Partner ${coverage.percent}%${
    extraMode ? " • Extra" : ""
  }`;

  const bottomBar = (
    <div className="space-y-3">
      {toast ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">
          {toast}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          {error}
        </div>
      ) : null}

      <Segmented value={activeTab} onChange={setActiveTab} />

      {activeTab === "play" ? (
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={generateRoundFair}
            disabled={tournamentFinished}
            className="rounded-2xl bg-emerald-600 px-4 py-4 text-base font-bold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-40"
          >
            Neue Runde
          </button>
          <button
            onClick={saveRound}
            disabled={tournamentFinished || !canSaveCurrentRound}
            className="rounded-2xl bg-black px-4 py-4 text-base font-bold text-white shadow-sm hover:opacity-95 disabled:opacity-40"
          >
            Speichern
          </button>
        </div>
      ) : null}
    </div>
  );

  const topRight = (
    <button
      onClick={resetAll}
      className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-semibold shadow-sm hover:bg-gray-50"
    >
      Reset
    </button>
  );

  const finishedBanner = tournamentFinished ? (
    <div className="mb-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-gray-200">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-base font-bold">🏁 Turnier beendet</div>
          <div className="mt-1 text-sm text-gray-600">
            {manualEnded
              ? `Manuell beendet • Runden: ${savedRounds.length}`
              : `Zielrunden erreicht: ${targetRounds} • Partner: ${coverage.percent}%`}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={playExtraRounds}
            className="rounded-xl bg-black px-4 py-2 text-sm font-bold text-white shadow-sm hover:opacity-95"
          >
            Extra-Runden
          </button>
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
                "Final kopiert ✅"
              )
            }
            className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-bold shadow-sm hover:bg-gray-50"
          >
            Copy Final
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const playContent = (
    <div className="space-y-4">
      {matches.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-700">
          {tournamentFinished ? (
            <>
              Turnier beendet. Tippe auf <span className="font-semibold">Extra-Runden</span> (unten), um weiterzuspielen.
            </>
          ) : (
            <>
              Noch keine aktive Runde. Tippe unten auf <span className="font-semibold">Neue Runde</span>.
            </>
          )}
        </div>
      ) : (
        matches.map((m) => {
          const r = results[m.court] ?? { scoreA: 0, scoreB: 0 };
          return (
            <div key={m.court} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-gray-200">
              <div className="flex items-center justify-between">
                <div className="text-sm font-bold">Court {m.court}</div>
                <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">2v2</span>
              </div>

              <div className="mt-3 grid gap-3">
                <div className="rounded-2xl bg-gray-50 p-4 ring-1 ring-gray-200">
                  <div className="text-xs font-semibold text-gray-600">Team A</div>
                  <div className="mt-1 text-base font-bold">
                    {m.teamA[0].name} <span className="text-gray-400">&</span> {m.teamA[1].name}
                  </div>
                  <div className="mt-3">
                    <ScorePill label="Punkte" value={r.scoreA} onChange={(v) => updateScore(m.court, "A", v)} />
                  </div>
                </div>

                <div className="text-center text-xs font-bold tracking-widest text-gray-400">VS</div>

                <div className="rounded-2xl bg-gray-50 p-4 ring-1 ring-gray-200">
                  <div className="text-xs font-semibold text-gray-600">Team B</div>
                  <div className="mt-1 text-base font-bold">
                    {m.teamB[0].name} <span className="text-gray-400">&</span> {m.teamB[1].name}
                  </div>
                  <div className="mt-3">
                    <ScorePill label="Punkte" value={r.scoreB} onChange={(v) => updateScore(m.court, "B", v)} />
                  </div>
                </div>
              </div>
            </div>
          );
        })
      )}

      {matches.length > 0 && unusedPlayers.length > 0 ? (
        <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
          <div className="font-bold">Pause</div>
          <div className="mt-1">{unusedPlayers.map((p) => p.name).join(", ")}</div>
        </div>
      ) : null}

      {!tournamentFinished ? (
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={deleteLastRound}
            disabled={savedRounds.length === 0}
            className="rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm font-bold shadow-sm hover:bg-gray-50 disabled:opacity-40"
          >
            Letzte löschen
          </button>
          <button
            onClick={endTournamentNow}
            className="rounded-2xl border border-red-200 bg-white px-4 py-3 text-sm font-bold text-red-700 shadow-sm hover:bg-red-50"
          >
            Turnier beenden
          </button>
        </div>
      ) : null}
    </div>
  );

  const rankingContent = (
    <div className="space-y-5">
      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
        <div>
          <div className="text-sm font-bold">Live Ranking (aktive Runde)</div>
          <div className="mt-1 text-xs text-gray-600">Nur auf Basis der aktuellen Scores.</div>
        </div>

        <div className="mt-4 space-y-2">
          {currentRoundRanking.map((r, i) => (
            <div key={r.id} className="flex items-center justify-between rounded-xl bg-gray-50 px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="w-7 text-sm font-black text-gray-500">{i + 1}</div>
                <div className="font-bold">{r.name}</div>
              </div>
              <div className="text-sm font-black">{r.points}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
        <div>
          <div className="text-sm font-bold">Gesamt Ranking</div>
          <div className="mt-1 text-xs text-gray-600">Summe aus gespeicherten Runden.</div>
        </div>

        <div className="mt-4 space-y-2">
          {totalRanking.map((r, i) => (
            <div key={r.id} className="flex items-center justify-between rounded-xl bg-gray-50 px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="w-7 text-sm font-black text-gray-500">{i + 1}</div>
                <div className="font-bold">{r.name}</div>
              </div>
              <div className="text-sm font-black">{r.points}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );

  const historyContent = (
    <div className="space-y-5">
      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-bold">Share</div>
            <div className="mt-1 text-xs text-gray-600">WhatsApp/Copy Export.</div>
          </div>
          <div className="flex flex-wrap gap-2">
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
                  "Final kopiert ✅"
                )
              }
              className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-bold shadow-sm hover:bg-gray-50"
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
                  "Report kopiert ✅"
                )
              }
              className="rounded-xl bg-black px-4 py-2 text-sm font-bold text-white shadow-sm hover:opacity-95"
            >
              Copy Report
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-bold">Runden History</div>
            <div className="mt-1 text-xs text-gray-600">Basis für Fairness & Coverage.</div>
          </div>
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">
            {savedRounds.length} Runde(n)
          </span>
        </div>

        <div className="mt-4 space-y-3">
          {savedRounds.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-6 text-sm text-gray-700">
              Noch keine Runde gespeichert.
            </div>
          ) : (
            savedRounds.map((round) => (
              <div key={round.id} className="rounded-2xl bg-gray-50 p-4 ring-1 ring-gray-200">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-black">Runde {fmtTime(round.createdAt)}</div>
                  <div className="text-xs font-semibold text-gray-600">{round.courts} Court(s)</div>
                </div>

                <div className="mt-3 space-y-2 text-sm">
                  {round.matches.map((m) => {
                    const r = round.results[m.court];
                    return (
                      <div key={m.court} className="rounded-xl bg-white p-3 ring-1 ring-gray-200">
                        <div className="flex items-center justify-between">
                          <div className="text-xs font-bold text-gray-600">Court {m.court}</div>
                          <div className="text-xs font-black text-gray-800">
                            {r.scoreA}:{r.scoreB}
                          </div>
                        </div>
                        <div className="mt-1 font-semibold">
                          {m.teamA[0].name} & {m.teamA[1].name}{" "}
                          <span className="text-gray-400">vs</span>{" "}
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
    </div>
  );

  return (
    <PageShell title={tournamentName} subtitle={headerSubtitle} topRight={topRight} bottomBar={(() => {
      const bar = (
        <div className="space-y-3">
          {toast ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">
              {toast}
            </div>
          ) : null}

          {error ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
              {error}
            </div>
          ) : null}

          <Segmented value={activeTab} onChange={setActiveTab} />

          {activeTab === "play" ? (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={generateRoundFair}
                disabled={tournamentFinished}
                className="rounded-2xl bg-emerald-600 px-4 py-4 text-base font-bold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-40"
              >
                Neue Runde
              </button>
              <button
                onClick={saveRound}
                disabled={tournamentFinished || !canSaveCurrentRound}
                className="rounded-2xl bg-black px-4 py-4 text-base font-bold text-white shadow-sm hover:opacity-95 disabled:opacity-40"
              >
                Speichern
              </button>
            </div>
          ) : null}
        </div>
      );
      return bar;
    })()}>
      {finishedBanner}

      <div className="mb-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-gray-200">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold text-gray-600">Partner-Coverage</div>
            <div className="mt-1 text-lg font-black">{coverage.percent}%</div>
          </div>
          <div className="text-right">
            <div className="text-xs font-semibold text-gray-600">Paarungen</div>
            <div className="mt-1 text-sm font-black">
              {coverage.totalPairs - coverage.missingPairs}/{coverage.totalPairs}
            </div>
          </div>
        </div>

        <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
          <div className="h-full rounded-full bg-black" style={{ width: `${coverage.percent}%` }} />
        </div>
      </div>

      {activeTab === "play" ? playContent : null}
      {activeTab === "ranking" ? rankingContent : null}
      {activeTab === "history" ? historyContent : null}
    </PageShell>
  );
}