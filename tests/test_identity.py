from unittest import TestCase, mock

from sharednet.identity import (
    BASE62,
    is_typed_id,
    new_agent_id,
    new_instance_id,
    new_principal_id,
    new_runtime_id,
)


class TypedIdentityTests(TestCase):
    def test_generated_ids_have_typed_ten_character_base62_bodies(self) -> None:
        self.assertRegex(new_principal_id(), r"^p_[0-9A-Za-z]{10}$")
        self.assertRegex(new_agent_id(), r"^a_[0-9A-Za-z]{10}$")
        self.assertRegex(new_runtime_id(), r"^r_[0-9A-Za-z]{10}$")
        self.assertRegex(new_instance_id(), r"^i_[0-9A-Za-z]{10}$")

    def test_typed_id_validation_rejects_wrong_prefix_case_and_length(self) -> None:
        self.assertTrue(is_typed_id("i_8pQ2Km7XaN", "i"))
        self.assertFalse(is_typed_id("principal_xisen", "p"))
        self.assertFalse(is_typed_id("a_8pQ2Km7XaN", "i"))
        self.assertFalse(is_typed_id("I_8pQ2Km7XaN", "i"))
        self.assertFalse(is_typed_id("i_8pQ2Km7Xa", "i"))
        self.assertFalse(is_typed_id("i_8pQ2Km7XaNN", "i"))

    @mock.patch("sharednet.identity.secrets.choice", side_effect=list("15COsXY9aK"))
    def test_generator_uses_the_configured_secure_alphabet(self, choice) -> None:
        self.assertEqual(new_principal_id(), "p_15COsXY9aK")
        self.assertEqual(choice.call_args_list, [mock.call(BASE62)] * 10)
