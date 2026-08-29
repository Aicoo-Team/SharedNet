"""Behavioral tests for the canonical coordination backend registry."""

from __future__ import annotations

import unittest

from sharednet.coordination.registry import UnknownMechanism, get_backend, list_mechanisms


class RegistryTests(unittest.TestCase):
    def test_default_mechanisms_are_stable_and_ordered(self) -> None:
        self.assertEqual(
            [item["id"] for item in list_mechanisms()],
            ["discovery-and-use", "rac-rge", "rac-adaptive", "peer-forum"],
        )

    def test_adpt_alias_resolves_to_canonical_adaptive_backend(self) -> None:
        self.assertEqual(get_backend("rac-adpt").mechanism_id, "rac-adaptive")

    def test_unknown_mechanism_is_explicit(self) -> None:
        with self.assertRaisesRegex(UnknownMechanism, "unknown coordination mechanism"):
            get_backend("mystery")


if __name__ == "__main__":
    unittest.main()
