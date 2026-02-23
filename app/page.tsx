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

type PersistedStateV5 = {
  version: 5;

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

const STORAGE_KEY = "americano_app_state_v5";
const PREFS_KEY = "americano_app_prefs_v1";

type Prefs = {
  autoNextRound: boolean;
  theme: "light" | "dark";
};

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

function asciiBar(percent: number, width = 10) {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * width);
  return `${"▓".repeat(filled)}${"░".repeat(Math.max(0, width - filled))} ${p}%`;
}

// --- Partner-Coverage (unique partnerships) ---
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

// Recommended rounds lower bound for partner coverage with court capacity
function recommendRoundsPartner(playerCount: number, courts: number) {
  if (playerCount < 4) return 0;
  const c = Math.max(1, Math.min(courts, Math.floor(playerCount / 4) || 1));
  // ceil( n*(n-1) / (4*courts) )
  const num = playerCount * (playerCount - 1);
  const den = 4 * c;
  return Math.max(1, Math.ceil(num / den));
}

// --- Fair round generator (partner-first) ---
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

  // Let low-games players play first (bench rotation fairness)
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const byGames = shuffled.sort((a, b) => (gamesPlayed[a.id] ?? 0) - (gamesPlayed[b.id] ?? 0));

  const active = byGames.slice(0, slots);
  const bench = byGames.slice(slots);

  const remaining = [...active];

  const partner = (x: string, y: string) => partnerCount[makeKey(x, y)] ?? 0;
  const opp = (x: string, y: string) => opponentCount[makeKey(x, y)] ?? 0;
  const gp = (x: string) => gamesPlayed[x] ?? 0;

  function matchScore(a: Player, b: Player, c: Player, d: Player) {
    // Partner repeats hurt most (partner coverage goal)
    const partnerPenalty = 14 * partner(a.id, b.id) + 14 * partner(c.id, d.id);
    // Opponent repeats mild penalty
    const opponentPenalty =
      3 * (opp(a.id, c.id) + opp(a.id, d.id) + opp(b.id, c.id) + opp(b.id, d.id));
    // Small bonus for players with fewer games
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

function clampInt(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function PageShell(props: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  bottomBar?: React.ReactNode;
  topRight?: React.ReactNode;
  theme: "light" | "dark";
}) {
  const isDark = props.theme === "dark";

  const pageBg = isDark ? "bg-zinc-950 text-zinc-50" : "bg-gray-50 text-gray-900";
  const topMuted = isDark ? "text-zinc-300" : "text-gray-600";
  const border = isDark ? "border-zinc-800" : "border-gray-200";
  const barBg = isDark ? "bg-zinc-950/95" : "bg-white/95";

  return (
    <main className={`min-h-screen ${pageBg}`}>
      <div className="mx-auto max-w-3xl px-4 pb-28 pt-8">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{props.title}</h1>
            {props.subtitle ? <p className={`mt-1 text-sm ${topMuted}`}>{props.subtitle}</p> : null}
          </div>
          {props.topRight}
        </div>

        <div className="mt-6">{props.children}</div>
      </div>

      {props.bottomBar ? (
        <div className={`fixed inset-x-0 bottom-0 z-50 border-t ${border} ${barBg} backdrop-blur`}>
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
  theme: "light" | "dark";
}) {
  const isDark = props.theme === "dark";
  const active = "bg-black text-white";
  const inactive = isDark ? "bg-zinc-900 text-zinc-100 hover:bg-zinc-800" : "bg-gray-100 text-gray-800 hover:bg-gray-200";

  const Btn = (p: { v: "play" | "ranking" | "history"; label: string }) => (
    <button
      onClick={() => props.onChange(p.v)}
      className={[
        "flex-1 rounded-xl px-3 py-2 text-sm font-semibold",
        props.value === p.v ? active : inactive,
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
  theme: "light" | "dark";
}) {
  const isDark = props.theme === "dark";
  const v = props.value === "" ? 0 : Number(props.value);

  const bump = (delta: number) => {
    const next = Math.max(0, v + delta);
    props.onChange(next);
  };

  const wrap = isDark ? "bg-zinc-900 ring-zinc-800" : "bg-gray-50 ring-gray-200";
  const btn = isDark ? "bg-zinc-950 ring-zinc-800 hover:bg-zinc-900" : "bg-white ring-gray-200 hover:bg-gray-100";
  const label = isDark ? "text-zinc-300" : "text-gray-600";
  const input = isDark
    ? "border-zinc-700 bg-zinc-950 text-zinc-50 focus:border-zinc-500"
    : "border-gray-300 bg-white text-gray-900 focus:border-gray-400";

  return (
    <div className={`rounded-2xl p-3 ring-1 ${wrap}`}>
      <div className={`text-xs font-semibold ${label}`}>{props.label}</div>

      <div className="mt-2 flex items-center justify-between gap-3">
        <button onClick={() => bump(-1)} className={`h-11 w-11 rounded-xl text-lg font-bold ring-1 ${btn}`}>
          −
        </button>

        <input
          inputMode="numeric"
          type="number"
          min={0}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value === "" ? "" : Math.max(0, Number(e.target.value)))}
          className={`w-20 rounded-xl border px-3 py-2 text-center text-lg font-bold outline-none ${input}`}
          placeholder="0"
        />

        <button onClick={() => bump(+1)} className={`h-11 w-11 rounded-xl text-lg font-bold ring-1 ${btn}`}>
          +
        </button>
      </div>

      <div className="mt-2 grid grid-cols-4 gap-2">
        {[+5, +10, +15, 0].map((x) =>
          x === 0 ? (
            <button
              key="reset"
              onClick={() => props.onChange(0)}
              className={`rounded-xl px-2 py-2 text-xs font-semibold ring-1 ${btn}`}
            >
              Reset
            </button>
          ) : (
            <button
              key={x}
              onClick={() => bump(x)}
              className={`rounded-xl px-2 py-2 text-xs font-semibold ring-1 ${btn}`}
            >
              +{x}
            </button>
          )
        )}
      </div>
    </div>
  );
}

function ToggleRow(props: {
  label: string;
  desc?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  theme: "light" | "dark";
}) {
  const isDark = props.theme === "dark";
  const box = isDark ? "bg-zinc-900 ring-zinc-800" : "bg-white ring-gray-200";
  const muted = isDark ? "text-zinc-300" : "text-gray-600";

  return (
    <div className={`rounded-2xl p-4 shadow-sm ring-1 ${box}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold">{props.label}</div>
          {props.desc ? <div className={`mt-1 text-xs ${muted}`}>{props.desc}</div> : null}
        </div>
        <button
          onClick={() => props.onChange(!props.value)}
          className={[
            "h-8 w-14 rounded-full p-1 transition",
            props.value ? "bg-emerald-600" : isDark ? "bg-zinc-700" : "bg-gray-300",
          ].join(" ")}
          aria-label={props.label}
        >
          <div
            className={[
              "h-6 w-6 rounded-full bg-white transition",
              props.value ? "translate-x-6" : "translate-x-0",
            ].join(" ")}
          />
        </button>
      </div>
    </div>
  );
}

export default function Home() {
  // --- Preferences (autoNext + theme) ---
  const [prefs, setPrefs] = useState<Prefs>({ autoNextRound: false, theme: "light" });

  // Setup
  const [setupDone, setSetupDone] = useState(false);
  const [tournamentName, setTournamentName] = useState("Mein Americano");

  // Player count: mobile-friendly free typing
  const [setupPlayerCount, setSetupPlayerCount] = useState(8);
  const [setupPlayerCountText, setSetupPlayerCountText] = useState("8");

  const [setupNames, setSetupNames] = useState<string[]>(Array.from({ length: 8 }, () => ""));

  // Courts: mobile-friendly free typing
  const [setupCourts, setSetupCourts] = useState(2);
  const [setupCourtsText, setSetupCourtsText] = useState("2");

  // Rounds: mobile-friendly free typing
  const [targetRounds, setTargetRounds] = useState(recommendRoundsPartner(8, 2));
  const [targetRoundsText, setTargetRoundsText] = useState(String(recommendRoundsPartner(8, 2)));

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

  const isDark = prefs.theme === "dark";
  const cardBg = isDark ? "bg-zinc-900 ring-zinc-800" : "bg-white ring-gray-200";
  const softBg = isDark ? "bg-zinc-950 ring-zinc-800" : "bg-gray-50 ring-gray-200";
  const mutedText = isDark ? "text-zinc-300" : "text-gray-600";
  const border = isDark ? "border-zinc-800" : "border-gray-200";
  const inputBase = isDark
    ? "border-zinc-700 bg-zinc-950 text-zinc-50 focus:border-zinc-500"
    : "border-gray-300 bg-white text-gray-900 focus:border-gray-400";

  // Load prefs + app state
  useEffect(() => {
    const p = safeParse<Prefs>(localStorage.getItem(PREFS_KEY));
    if (p?.theme && p?.autoNextRound !== undefined) setPrefs(p);

    const parsed = safeParse<PersistedStateV5>(localStorage.getItem(STORAGE_KEY));
    if (parsed && parsed.version === 5) {
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

  // Save prefs
  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }, [prefs, loaded]);

  // Save app state
  useEffect(() => {
    if (!loaded) return;
    const payload: PersistedStateV5 = {
      version: 5,
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

  // Keep names array size synced with numeric count
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

    // keep numeric rounds in sync if user hasn't set a custom value yet
    setTargetRounds((curr) => {
      if (curr <= 0) return rec;
      return curr;
    });

    // if targetRoundsText equals previous computed value or is empty, keep it aligned
    setTargetRoundsText((currTxt) => {
      if (!currTxt) return String(rec);
      const currNum = Number(currTxt);
      if (!Number.isFinite(currNum) || currNum <= 0) return String(rec);
      return currTxt;
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

  // Pause tracking from saved rounds (no schema change)
  const pauseCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    players.forEach((p) => (counts[p.id] = 0));

    for (const round of savedRounds) {
      const used = new Set<string>();
      for (const m of round.matches) {
        m.teamA.forEach((p) => used.add(p.id));
        m.teamB.forEach((p) => used.add(p.id));
      }
      for (const p of players) {
        if (!used.has(p.id)) counts[p.id] += 1;
      }
    }
    return counts;
  }, [players, savedRounds]);

  const mostBenched = useMemo(() => {
    if (players.length === 0) return [];
    const rows = players.map((p) => ({ id: p.id, name: p.name, rests: pauseCounts[p.id] ?? 0 }));
    rows.sort((a, b) => b.rests - a.rests || a.name.localeCompare(b.name, "de"));
    return rows.slice(0, 3);
  }, [players, pauseCounts]);

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
    setSetupCourtsText("2");

    const rec = recommendRoundsPartner(8, 2);
    setTargetRounds(rec);
    setTargetRoundsText(String(rec));

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

  function applyPreset(preset: { players: number; courts: number; name?: string }) {
    const pc = Math.max(4, preset.players);
    const maxC = Math.max(1, Math.floor(pc / 4));
    const c = clampInt(preset.courts, 1, maxC);

    setSetupPlayerCount(pc);
    setSetupPlayerCountText(String(pc));

    setSetupCourts(c);
    setSetupCourtsText(String(c));

    const rec = recommendRoundsPartner(pc, c);
    setTargetRounds(rec);
    setTargetRoundsText(String(rec));

    setSetupNames(Array.from({ length: pc }, (_, i) => `Spieler ${i + 1}`));
    if (preset.name) setTournamentName(preset.name);
    setToast("Preset geladen ✅");
  }

  function normalizeSetupNumbers() {
    // Player count
    const rawCount = Number(setupPlayerCountText);
    const finalCount = Number.isFinite(rawCount) && rawCount > 0 ? Math.max(4, rawCount) : 8;
    if (finalCount !== setupPlayerCount) setSetupPlayerCount(finalCount);
    if (String(finalCount) !== setupPlayerCountText) setSetupPlayerCountText(String(finalCount));

    // Courts
    const maxCourtsSetup = Math.max(1, Math.floor(finalCount / 4));
    const rawCourts = Number(setupCourtsText);
    const finalCourts = Number.isFinite(rawCourts) && rawCourts > 0 ? clampInt(rawCourts, 1, maxCourtsSetup) : 1;
    if (finalCourts !== setupCourts) setSetupCourts(finalCourts);
    if (String(finalCourts) !== setupCourtsText) setSetupCourtsText(String(finalCourts));

    // Rounds
    const rawRounds = Number(targetRoundsText);
    const rec = recommendRoundsPartner(finalCount, finalCourts);
    const finalRounds = Number.isFinite(rawRounds) && rawRounds > 0 ? Math.max(1, rawRounds) : rec;
    if (finalRounds !== targetRounds) setTargetRounds(finalRounds);
    if (String(finalRounds) !== targetRoundsText) setTargetRoundsText(String(finalRounds));

    return { finalCount, finalCourts, finalRounds, rec };
  }

  function startTournamentFromSetup() {
    setError("");

    const { finalCount, finalCourts, finalRounds } = normalizeSetupNumbers();

    const tName = tournamentName.trim();
    const names = setupNames.slice(0, finalCount).map((n) => n.trim());

    if (tName.length < 2) return setError("Bitte einen Turniernamen eingeben.");
    if (finalCount < 4) return setError("Mindestens 4 Spieler:innen.");

    if (names.some((n) => n.length === 0)) return setError("Bitte alle Namen eintragen (oder Auto-Fill nutzen).");

    const newPlayers: Player[] = names.map((n) => ({ id: crypto.randomUUID(), name: n }));

    setPlayers(newPlayers);
    setCourts(finalCourts);
    setTargetRounds(finalRounds);

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

    // ✅ Auto-next round
    if (prefs.autoNextRound) {
      // slight delay so UI updates feel natural
      setTimeout(() => {
        // avoid generating if tournament ended by this save
        const willEnd = !extraMode && targetRounds > 0 && savedRounds.length + 1 >= targetRounds;
        if (!willEnd) generateRoundFair();
      }, 250);
    }
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
        theme={prefs.theme}
        title="Americano Organizer"
        subtitle="Setup → Start → Spielen"
        topRight={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPrefs((p) => ({ ...p, theme: p.theme === "dark" ? "light" : "dark" }))}
              className={`rounded-xl border px-3 py-2 text-sm font-semibold shadow-sm hover:opacity-95 ${
                isDark ? "border-zinc-800 bg-zinc-900" : "border-gray-200 bg-white"
              }`}
              title="Dark Mode"
            >
              {isDark ? "🌙" : "☀️"}
            </button>
            <button
              onClick={resetAll}
              className={`rounded-xl border px-3 py-2 text-sm font-semibold shadow-sm hover:opacity-95 ${
                isDark ? "border-zinc-800 bg-zinc-900" : "border-gray-200 bg-white"
              }`}
            >
              Reset
            </button>
          </div>
        }
      >
        {toast ? (
          <div
            className={`mb-4 rounded-2xl border px-4 py-3 text-sm font-semibold ${
              isDark ? "border-emerald-900 bg-emerald-950 text-emerald-200" : "border-emerald-200 bg-emerald-50 text-emerald-900"
            }`}
          >
            {toast}
          </div>
        ) : null}

        {error ? (
          <div
            className={`mb-4 rounded-2xl border px-4 py-3 text-sm ${
              isDark ? "border-red-900 bg-red-950 text-red-200" : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            {error}
          </div>
        ) : null}

        <div className="space-y-5">
          {/* Quick Start Presets */}
          <section className={`rounded-2xl p-5 shadow-sm ring-1 ${cardBg}`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold">Quick Start</div>
                <div className={`mt-1 text-xs ${mutedText}`}>1 Tap → Auto-Namen, Courts, Runden-Vorschlag.</div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <button
                onClick={() => applyPreset({ players: 4, courts: 1 })}
                className={`rounded-2xl px-3 py-3 text-sm font-bold ring-1 hover:opacity-95 ${softBg}`}
              >
                4 · 1
              </button>
              <button
                onClick={() => applyPreset({ players: 6, courts: 1 })}
                className={`rounded-2xl px-3 py-3 text-sm font-bold ring-1 hover:opacity-95 ${softBg}`}
              >
                6 · 1
              </button>
              <button
                onClick={() => applyPreset({ players: 8, courts: 2 })}
                className={`rounded-2xl px-3 py-3 text-sm font-bold ring-1 hover:opacity-95 ${softBg}`}
              >
                8 · 2
              </button>
              <button
                onClick={() => applyPreset({ players: 12, courts: 3 })}
                className={`rounded-2xl px-3 py-3 text-sm font-bold ring-1 hover:opacity-95 ${softBg}`}
              >
                12 · 3
              </button>
            </div>
          </section>

          <section className={`rounded-2xl p-5 shadow-sm ring-1 ${cardBg}`}>
            <div className="text-sm font-bold">Turniername</div>
            <input
              value={tournamentName}
              onChange={(e) => setTournamentName(e.target.value)}
              className={`mt-2 w-full rounded-xl border px-3 py-3 text-base outline-none ${inputBase}`}
              placeholder="z.B. Padel Americano Freitag"
            />
          </section>

          <section className={`rounded-2xl p-5 shadow-sm ring-1 ${cardBg}`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold">Spieler:innen</div>
                <div className={`mt-1 text-xs ${mutedText}`}>Mobile-friendly: frei löschen & tippen.</div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() =>
                    setSetupNames((prev) => prev.map((v, i) => (v.trim().length === 0 ? `Spieler ${i + 1}` : v)))
                  }
                  className={`rounded-xl border px-3 py-2 text-sm font-semibold shadow-sm hover:opacity-95 ${
                    isDark ? "border-zinc-800 bg-zinc-900" : "border-gray-200 bg-white"
                  }`}
                >
                  Auto-Fill
                </button>
                <button
                  onClick={() => setSetupNames((prev) => prev.map(() => ""))}
                  className={`rounded-xl border px-3 py-2 text-sm font-semibold shadow-sm hover:opacity-95 ${
                    isDark ? "border-zinc-800 bg-zinc-900" : "border-gray-200 bg-white"
                  }`}
                >
                  Leeren
                </button>
              </div>
            </div>

            <div className="mt-4">
              <label className="text-sm font-semibold">Anzahl</label>

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

                  // auto-adjust courts suggestion
                  const maxC = Math.max(1, Math.floor(fixed / 4));
                  const current = Number(setupCourtsText);
                  if (!Number.isFinite(current) || current <= 0 || current > maxC) {
                    const suggested = clampInt(Math.min(maxC, setupCourts || 1), 1, maxC);
                    setSetupCourts(suggested);
                    setSetupCourtsText(String(suggested));
                  }

                  // refresh rounds suggestion
                  const rec2 = recommendRoundsPartner(fixed, clampInt(Number(setupCourtsText || suggested), 1, maxC));
                  if (!targetRoundsText) setTargetRoundsText(String(rec2));
                  if (!targetRounds || targetRounds <= 0) setTargetRounds(rec2);
                }}
                className={`mt-2 w-full rounded-xl border px-3 py-3 text-base outline-none ${inputBase}`}
                placeholder="z.B. 6"
              />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {setupNames.map((val, idx) => (
                <label key={idx} className="text-sm font-semibold">
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
                    className={`mt-2 w-full rounded-xl border px-3 py-3 text-base outline-none ${inputBase}`}
                    placeholder={`Name ${idx + 1}`}
                  />
                </label>
              ))}
            </div>
          </section>

          <section className={`rounded-2xl p-5 shadow-sm ring-1 ${cardBg}`}>
            <div className="text-sm font-bold">Courts & Runden</div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-sm font-semibold">Courts (max. {possibleCourtsSetup})</label>

                {/* ✅ FIX: free typing */}
                <input
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={setupCourtsText}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setSetupCourtsText(e.target.value.replace(/[^\d]/g, ""))}
                  onBlur={() => {
                    const maxC = Math.max(1, Math.floor(setupPlayerCount / 4));
                    const n = Number(setupCourtsText);
                    const fixed = Number.isFinite(n) && n > 0 ? clampInt(n, 1, maxC) : 1;
                    setSetupCourts(fixed);
                    setSetupCourtsText(String(fixed));

                    const rec2 = recommendRoundsPartner(setupPlayerCount, fixed);
                    if (!targetRoundsText) setTargetRoundsText(String(rec2));
                    if (!targetRounds || targetRounds <= 0) setTargetRounds(rec2);
                  }}
                  className={`mt-2 w-full rounded-xl border px-3 py-3 text-base outline-none ${inputBase}`}
                  placeholder="z.B. 2"
                />
              </div>

              <div>
                <label className="text-sm font-semibold">Runden (Vorschlag: {rec})</label>

                {/* ✅ FIX: free typing */}
                <input
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={targetRoundsText}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setTargetRoundsText(e.target.value.replace(/[^\d]/g, ""))}
                  onBlur={() => {
                    const n = Number(targetRoundsText);
                    const fixed = Number.isFinite(n) && n > 0 ? Math.max(1, n) : rec;
                    setTargetRounds(fixed);
                    setTargetRoundsText(String(fixed));
                  }}
                  className={`mt-2 w-full rounded-xl border px-3 py-3 text-base outline-none ${inputBase}`}
                  placeholder={String(rec)}
                />
              </div>
            </div>

            <div className={`mt-4 rounded-2xl p-4 text-sm ring-1 ${softBg}`}>
              <div className="font-semibold">Padel-Logik: Partner-Coverage</div>
              <div className={`mt-1 ${mutedText}`}>
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
        <div
          className={`rounded-2xl border px-4 py-3 text-sm font-semibold ${
            isDark ? "border-emerald-900 bg-emerald-950 text-emerald-200" : "border-emerald-200 bg-emerald-50 text-emerald-900"
          }`}
        >
          {toast}
        </div>
      ) : null}

      {error ? (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm font-semibold ${
            isDark ? "border-red-900 bg-red-950 text-red-200" : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {error}
        </div>
      ) : null}

      <Segmented value={activeTab} onChange={setActiveTab} theme={prefs.theme} />

      {activeTab === "play" ? (
        <>
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

          <ToggleRow
            theme={prefs.theme}
            label="Auto Next Round"
            desc="Nach „Speichern“ automatisch neue Runde generieren."
            value={prefs.autoNextRound}
            onChange={(v) => setPrefs((p) => ({ ...p, autoNextRound: v }))}
          />
        </>
      ) : null}
    </div>
  );

  const topRight = (
    <div className="flex items-center gap-2">
      <button
        onClick={() => setPrefs((p) => ({ ...p, theme: p.theme === "dark" ? "light" : "dark" }))}
        className={`rounded-xl border px-3 py-2 text-sm font-semibold shadow-sm hover:opacity-95 ${
          isDark ? "border-zinc-800 bg-zinc-900" : "border-gray-200 bg-white"
        }`}
        title="Dark Mode"
      >
        {isDark ? "🌙" : "☀️"}
      </button>
      <button
        onClick={resetAll}
        className={`rounded-xl border px-3 py-2 text-sm font-semibold shadow-sm hover:opacity-95 ${
          isDark ? "border-zinc-800 bg-zinc-900" : "border-gray-200 bg-white"
        }`}
      >
        Reset
      </button>
    </div>
  );

  const tournamentFinished =
    manualEnded || (!extraMode && targetRounds > 0 && savedRounds.length >= targetRounds);

  const finishedBanner = tournamentFinished ? (
    <div className={`mb-4 rounded-2xl p-4 shadow-sm ring-1 ${cardBg}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-base font-bold">🏁 Turnier beendet</div>
          <div className={`mt-1 text-sm ${mutedText}`}>
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
            className={`rounded-xl border px-4 py-2 text-sm font-bold shadow-sm hover:opacity-95 ${
              isDark ? "border-zinc-800 bg-zinc-900" : "border-gray-200 bg-white"
            }`}
          >
            Copy Final
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // ------------- PLAY TAB -------------
  const playContent = (
    <div className="space-y-4">
      {matches.length === 0 ? (
        <div className={`rounded-2xl border border-dashed p-6 text-sm ${isDark ? "border-zinc-700 bg-zinc-900/30 text-zinc-200" : "border-gray-300 bg-gray-50 text-gray-700"}`}>
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
            <div key={m.court} className={`rounded-2xl p-4 shadow-sm ring-1 ${cardBg}`}>
              <div className="flex items-center justify-between">
                <div className="text-sm font-bold">Court {m.court}</div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${isDark ? "bg-zinc-950 ring-1 ring-zinc-800 text-zinc-200" : "bg-gray-100 text-gray-700"}`}>
                  2v2
                </span>
              </div>

              <div className="mt-3 grid gap-3">
                <div className={`rounded-2xl p-4 ring-1 ${softBg}`}>
                  <div className={`text-xs font-semibold ${mutedText}`}>Team A</div>
                  <div className="mt-1 text-base font-bold">
                    {m.teamA[0].name} <span className={isDark ? "text-zinc-500" : "text-gray-400"}>&</span> {m.teamA[1].name}
                  </div>
                  <div className="mt-3">
                    <ScorePill theme={prefs.theme} label="Punkte" value={r.scoreA} onChange={(v) => updateScore(m.court, "A", v)} />
                  </div>
                </div>

                <div className={`text-center text-xs font-bold tracking-widest ${isDark ? "text-zinc-500" : "text-gray-400"}`}>
                  VS
                </div>

                <div className={`rounded-2xl p-4 ring-1 ${softBg}`}>
                  <div className={`text-xs font-semibold ${mutedText}`}>Team B</div>
                  <div className="mt-1 text-base font-bold">
                    {m.teamB[0].name} <span className={isDark ? "text-zinc-500" : "text-gray-400"}>&</span> {m.teamB[1].name}
                  </div>
                  <div className="mt-3">
                    <ScorePill theme={prefs.theme} label="Punkte" value={r.scoreB} onChange={(v) => updateScore(m.court, "B", v)} />
                  </div>
                </div>
              </div>
            </div>
          );
        })
      )}

      {matches.length > 0 && unusedPlayers.length > 0 ? (
        <div className={`rounded-2xl p-4 text-sm ring-1 ${isDark ? "bg-amber-950/40 text-amber-200 ring-amber-900" : "bg-amber-50 text-amber-900 ring-amber-200"}`}>
          <div className="font-bold">Pause</div>
          <div className="mt-1">{unusedPlayers.map((p) => p.name).join(", ")}</div>
        </div>
      ) : null}

      {!tournamentFinished ? (
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={deleteLastRound}
            disabled={savedRounds.length === 0}
            className={`rounded-2xl border px-4 py-3 text-sm font-bold shadow-sm hover:opacity-95 disabled:opacity-40 ${
              isDark ? "border-zinc-800 bg-zinc-900" : "border-gray-200 bg-white"
            }`}
          >
            Letzte löschen
          </button>
          <button
            onClick={endTournamentNow}
            className={`rounded-2xl border px-4 py-3 text-sm font-bold shadow-sm hover:opacity-95 ${
              isDark ? "border-red-900 bg-zinc-900 text-red-300 hover:bg-red-950/30" : "border-red-200 bg-white text-red-700 hover:bg-red-50"
            }`}
          >
            Turnier beenden
          </button>
        </div>
      ) : null}
    </div>
  );

  // ------------- RANKING TAB -------------
  const medal = (idx: number) => (idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `${idx + 1}.`);
  const topRowBg = (idx: number) => {
    if (idx === 0) return isDark ? "bg-amber-950/40 ring-amber-900" : "bg-amber-50 ring-amber-200";
    if (idx === 1) return isDark ? "bg-zinc-800/60 ring-zinc-700" : "bg-gray-100 ring-gray-200";
    if (idx === 2) return isDark ? "bg-orange-950/30 ring-orange-900" : "bg-orange-50 ring-orange-200";
    return isDark ? "bg-zinc-950 ring-zinc-800" : "bg-gray-50 ring-gray-200";
  };

  const rankingContent = (
    <div className="space-y-5">
      <section className={`rounded-2xl p-5 shadow-sm ring-1 ${cardBg}`}>
        <div>
          <div className="text-sm font-bold">Gesamt Ranking</div>
          <div className={`mt-1 text-xs ${mutedText}`}>Summe aus gespeicherten Runden.</div>
        </div>

        <div className="mt-4 space-y-2">
          {totalRanking.map((r, i) => (
            <div key={r.id} className={`flex items-center justify-between rounded-xl px-4 py-3 ring-1 ${topRowBg(i)}`}>
              <div className="flex items-center gap-3">
                <div className="w-10 text-sm font-black">{medal(i)}</div>
                <div className="font-bold">{r.name}</div>
              </div>
              <div className="text-sm font-black">{r.points}</div>
            </div>
          ))}
        </div>
      </section>

      <section className={`rounded-2xl p-5 shadow-sm ring-1 ${cardBg}`}>
        <div>
          <div className="text-sm font-bold">Pause-Tracking</div>
          <div className={`mt-1 text-xs ${mutedText}`}>Wer hat am meisten pausiert?</div>
        </div>

        <div className="mt-4 space-y-2">
          {mostBenched.length === 0 ? (
            <div className={`rounded-xl px-4 py-3 ring-1 ${softBg} ${mutedText}`}>Noch keine Daten.</div>
          ) : (
            mostBenched.map((x, idx) => (
              <div key={x.id} className={`flex items-center justify-between rounded-xl px-4 py-3 ring-1 ${softBg}`}>
                <div className="flex items-center gap-3">
                  <div className="w-10 text-sm font-black">{idx === 0 ? "🧊" : idx === 1 ? "⏸️" : "🪑"}</div>
                  <div className="font-bold">{x.name}</div>
                </div>
                <div className="text-sm font-black">{x.rests} Pause(n)</div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );

  // ------------- HISTORY TAB -------------
  const historyContent = (
    <div className="space-y-5">
      <section className={`rounded-2xl p-5 shadow-sm ring-1 ${cardBg}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-bold">Share</div>
            <div className={`mt-1 text-xs ${mutedText}`}>WhatsApp/Copy Export.</div>
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
              className={`rounded-xl border px-4 py-2 text-sm font-bold shadow-sm hover:opacity-95 ${
                isDark ? "border-zinc-800 bg-zinc-900" : "border-gray-200 bg-white"
              }`}
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

      <section className={`rounded-2xl p-5 shadow-sm ring-1 ${cardBg}`}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-bold">Runden History</div>
            <div className={`mt-1 text-xs ${mutedText}`}>Basis für Fairness & Coverage.</div>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${isDark ? "bg-zinc-950 ring-1 ring-zinc-800 text-zinc-200" : "bg-gray-100 text-gray-700"}`}>
            {savedRounds.length} Runde(n)
          </span>
        </div>

        <div className="mt-4 space-y-3">
          {savedRounds.length === 0 ? (
            <div className={`rounded-2xl border border-dashed p-6 text-sm ${isDark ? "border-zinc-700 bg-zinc-900/30 text-zinc-200" : "border-gray-300 bg-gray-50 text-gray-700"}`}>
              Noch keine Runde gespeichert.
            </div>
          ) : (
            savedRounds.map((round) => (
              <div key={round.id} className={`rounded-2xl p-4 ring-1 ${softBg}`}>
                <div className="flex items-center justify-between">
                  <div className="text-sm font-black">Runde {fmtTime(round.createdAt)}</div>
                  <div className={`text-xs font-semibold ${mutedText}`}>{round.courts} Court(s)</div>
                </div>

                <div className="mt-3 space-y-2 text-sm">
                  {round.matches.map((m) => {
                    const r = round.results[m.court];
                    return (
                      <div key={m.court} className={`rounded-xl p-3 ring-1 ${cardBg}`}>
                        <div className="flex items-center justify-between">
                          <div className={`text-xs font-bold ${mutedText}`}>Court {m.court}</div>
                          <div className="text-xs font-black">
                            {r.scoreA}:{r.scoreB}
                          </div>
                        </div>
                        <div className="mt-1 font-semibold">
                          {m.teamA[0].name} & {m.teamA[1].name}{" "}
                          <span className={isDark ? "text-zinc-500" : "text-gray-400"}>vs</span>{" "}
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

  const coverageCard = (
    <div className={`mb-4 rounded-2xl p-4 shadow-sm ring-1 ${cardBg}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className={`text-xs font-semibold ${mutedText}`}>Partner-Coverage</div>
          <div className="mt-1 text-lg font-black">{coverage.percent}%</div>
          <div className={`mt-1 text-xs ${mutedText}`}>{asciiBar(coverage.percent, 10)}</div>
        </div>
        <div className="text-right">
          <div className={`text-xs font-semibold ${mutedText}`}>Paarungen</div>
          <div className="mt-1 text-sm font-black">
            {coverage.totalPairs - coverage.missingPairs}/{coverage.totalPairs}
          </div>
        </div>
      </div>

      <div className={`mt-3 h-2 overflow-hidden rounded-full ${isDark ? "bg-zinc-950" : "bg-gray-100"}`}>
        <div className="h-full rounded-full bg-black" style={{ width: `${coverage.percent}%` }} />
      </div>
    </div>
  );

  return (
    <PageShell theme={prefs.theme} title={tournamentName} subtitle={headerSubtitle} topRight={topRight} bottomBar={bottomBar}>
      {finishedBanner}
      {coverageCard}

      {activeTab === "play" ? playContent : null}
      {activeTab === "ranking" ? rankingContent : null}
      {activeTab === "history" ? historyContent : null}
    </PageShell>
  );
}