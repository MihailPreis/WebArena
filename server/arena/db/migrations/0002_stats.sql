CREATE TABLE matches (
    id           INTEGER PRIMARY KEY,
    room_code    TEXT NOT NULL,
    map          TEXT NOT NULL,
    mode         TEXT NOT NULL,
    kill_limit   INTEGER NOT NULL,
    time_limit_s INTEGER NOT NULL,
    started_at   INTEGER NOT NULL,
    ended_at     INTEGER NOT NULL
);

CREATE TABLE match_players (
    match_id     INTEGER NOT NULL REFERENCES matches (id),
    player_id    TEXT NOT NULL REFERENCES players (id),
    kills        INTEGER NOT NULL,
    deaths       INTEGER NOT NULL,
    headshots    INTEGER NOT NULL,
    shots        INTEGER NOT NULL,
    hits         INTEGER NOT NULL,
    damage_dealt INTEGER NOT NULL,
    damage_taken INTEGER NOT NULL,
    playtime_s   INTEGER NOT NULL,
    place        INTEGER NOT NULL,
    won          INTEGER NOT NULL,
    PRIMARY KEY (match_id, player_id)
);

CREATE INDEX match_players_by_player ON match_players (player_id);

-- Running totals per player, so leaderboards do not scan every match.
-- Can be rebuilt from match_players at any time.
CREATE TABLE player_stats (
    player_id    TEXT PRIMARY KEY REFERENCES players (id),
    matches      INTEGER NOT NULL DEFAULT 0,
    wins         INTEGER NOT NULL DEFAULT 0,
    kills        INTEGER NOT NULL DEFAULT 0,
    deaths       INTEGER NOT NULL DEFAULT 0,
    headshots    INTEGER NOT NULL DEFAULT 0,
    shots        INTEGER NOT NULL DEFAULT 0,
    hits         INTEGER NOT NULL DEFAULT 0,
    damage_dealt INTEGER NOT NULL DEFAULT 0,
    damage_taken INTEGER NOT NULL DEFAULT 0,
    playtime_s   INTEGER NOT NULL DEFAULT 0
);
