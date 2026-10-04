"""Mirror of client/src/game/sim/weapon.ts. Change both together.

Timing is counted in simulation ticks, i.e. in player inputs, so the client can
predict its own weapon exactly and the fire rate cannot be exceeded.
"""

from dataclasses import dataclass

from arena.shared import CONSTANTS

_WEAPON = CONSTANTS["weapon"]

MAGAZINE: int = _WEAPON["magazine"]
FIRE_INTERVAL_TICKS: int = _WEAPON["fireIntervalTicks"]
RELOAD_TICKS: int = _WEAPON["reloadTicks"]


@dataclass(frozen=True)
class WeaponState:
    ammo: int = MAGAZINE
    cooldown: int = 0
    """Ticks until the next shot is allowed."""
    reload: int = 0
    """Ticks of reloading left; 0 when not reloading."""


def step_weapon(prev: WeaponState, fire: bool, reload: bool) -> tuple[WeaponState, bool]:
    """Advances the weapon by one tick. Returns the new state and whether a shot was fired."""
    ammo = prev.ammo
    cooldown = max(prev.cooldown - 1, 0)
    reloading = prev.reload
    fired = False

    if reloading > 0:
        reloading -= 1
        if reloading == 0:
            ammo = MAGAZINE
    elif (reload and ammo < MAGAZINE) or ammo == 0:
        reloading = RELOAD_TICKS
    elif fire and cooldown == 0:
        ammo -= 1
        cooldown = FIRE_INTERVAL_TICKS
        fired = True

    return WeaponState(ammo, cooldown, reloading), fired
