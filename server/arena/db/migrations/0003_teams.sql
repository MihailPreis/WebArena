-- Side the player was on in a team mode; NULL in a free-for-all.
ALTER TABLE match_players ADD COLUMN team TEXT;
