from unittest import TestCase, mock

from sharednet.identity import is_typed_id, new_agent_id, new_principal_id


class TypedIdentityTests(TestCase):
    def test_generated_ids_have_typed_ten_character_base62_bodies(self) -> None:
        self.assertRegex(new_principal_id(), r"^p_[0-9A-Za-z]{10}$")
        self.assertRegex(new_agent_id(), r"^a_[0-9A-Za-z]{10}$")
        self.assertTrue(is_typed_id("i_8pQ2Km7XaN", "i"))
        self.assertFalse(is_typed_id("principal_xisen", "p"))

    @mock.patch("sharednet.identity.secrets.choice", side_effect=list("15COsXY9aK"))
    def test_generator_uses_the_configured_secure_alphabet(self, _choice) -> None:
        self.assertEqual(new_principal_id(), "p_15COsXY9aK")
