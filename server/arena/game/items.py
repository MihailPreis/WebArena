"""Things lying on the map: weapons, ammunition, health, armour and the damage booster.

What each type gives is data in shared/constants.json; the map only names the type.
"""

from dataclasses import dataclass

from arena.shared import CONSTANTS

_ITEMS = CONSTANTS["items"]

PICKUP_RADIUS: float = _ITEMS["radius"]

WEAPON = "weapon"
AMMO = "ammo"
HEALTH = "health"
ARMOR = "armor"
QUAD = "quad"


@dataclass(frozen=True)
class ItemSpec:
    kind: str
    weapon: int
    """Index of the weapon given or fed; -1 for the other kinds."""
    amount: int
    """Points of health or armour."""
    respawn_s: float


ITEM_TYPES: dict[str, ItemSpec] = {
    name: ItemSpec(raw["kind"], raw["weapon"], raw["amount"], raw["respawnS"])
    for name, raw in _ITEMS["types"].items()
}
