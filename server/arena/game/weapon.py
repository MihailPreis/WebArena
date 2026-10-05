"""Mirror of client/src/game/sim/weapon.ts. Change both together.

Timing is counted in simulation ticks, i.e. in player inputs, so the client can
predict its own weapon exactly and the fire rate cannot be exceeded.
"""

import dataclasses
from dataclasses import dataclass

from arena.shared import CONSTANTS

SWITCH_TICKS: int = CONSTANTS["combat"]["switchTicks"]

HITSCAN = "hitscan"
PROJECTILE = "projectile"


@dataclass(frozen=True)
class WeaponSpec:
    id: str
    kind: str
    damage: int
    """Per pellet; for a projectile, at the centre of the blast."""
    head_multiplier: float
    interval_ticks: int
    pellets: int
    spread: float
    """Radius of the pellet pattern, as a tangent of the angle from the aim."""
    start_ammo: int
    pickup_ammo: int
    """Rounds in a box of ammunition and in the weapon itself when picked up."""
    max_ammo: int


WEAPONS: tuple[WeaponSpec, ...] = tuple(
    WeaponSpec(
        raw["id"],
        raw["kind"],
        raw["damage"],
        raw["headMultiplier"],
        raw["intervalTicks"],
        raw["pellets"],
        raw["spread"],
        raw["startAmmo"],
        raw["pickupAmmo"],
        raw["maxAmmo"],
    )
    for raw in CONSTANTS["weapons"]
)

_START_AMMO = tuple(spec.start_ammo for spec in WEAPONS)
# A player spawns holding every weapon that comes with ammunition.
_START_OWNED = sum(1 << i for i, spec in enumerate(WEAPONS) if spec.start_ammo > 0)


@dataclass(frozen=True)
class WeaponState:
    current: int = 0
    """Index of the weapon in hand."""
    ammo: tuple[int, ...] = _START_AMMO
    owned: int = _START_OWNED
    """Bit `i` is set when weapon `i` has been picked up."""
    cooldown: int = 0
    """Ticks until the next shot is allowed."""


def _with_ammo(ammo: tuple[int, ...], index: int, amount: int) -> tuple[int, ...]:
    return (*ammo[:index], amount, *ammo[index + 1 :])


def usable(state: WeaponState, index: int) -> bool:
    """Whether the player has the weapon and something to fire from it."""
    return (state.owned >> index) & 1 == 1 and state.ammo[index] > 0


def step_weapon(prev: WeaponState, fire: bool, want: int) -> tuple[WeaponState, bool]:
    """Advances the weapons by one tick. `want` is the weapon the player asks for.

    Returns the new state and whether a shot was fired, from `current` of that state.
    """
    current = prev.current
    ammo = prev.ammo
    cooldown = max(prev.cooldown - 1, 0)
    fired = False

    switch = current
    if want != current and usable(prev, want):
        switch = want
    elif ammo[current] == 0:
        # Out of ammunition: fall back to the best weapon that still has some.
        for index in range(len(WEAPONS) - 1, -1, -1):
            if usable(prev, index):
                switch = index
                break
    if switch != current:
        current = switch
        cooldown = max(cooldown, SWITCH_TICKS)

    if fire and cooldown == 0 and ammo[current] > 0:
        ammo = _with_ammo(ammo, current, ammo[current] - 1)
        cooldown = WEAPONS[current].interval_ticks
        fired = True

    return WeaponState(current, ammo, prev.owned, cooldown), fired


def give_ammo(state: WeaponState, index: int) -> WeaponState | None:
    """Adds a box of ammunition; None when the player cannot carry any more."""
    spec = WEAPONS[index]
    if state.ammo[index] >= spec.max_ammo:
        return None
    amount = min(state.ammo[index] + spec.pickup_ammo, spec.max_ammo)
    return dataclasses.replace(state, ammo=_with_ammo(state.ammo, index, amount))


def give_weapon(state: WeaponState, index: int) -> WeaponState | None:
    """Hands over a weapon with its ammunition; None when that would change nothing."""
    owned = state.owned | (1 << index)
    loaded = give_ammo(state, index)
    if loaded is None and owned == state.owned:
        return None
    return dataclasses.replace(loaded or state, owned=owned)
