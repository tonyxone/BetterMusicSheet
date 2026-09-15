import unittest
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError
from fastapi import HTTPException

import auth
import server
import db


USER_ID = "11111111-1111-4111-8111-111111111111"


class DeleteAccountTests(unittest.TestCase):
    def test_rejects_a_guest(self):
        with self.assertRaises(HTTPException) as error:
            server.delete_account(None)
        self.assertEqual(error.exception.status_code, 401)

    def test_rejects_while_a_job_is_in_progress(self):
        with (
            patch.object(server.db, "get_in_progress_job", return_value={"job_id": "job-1"}),
            patch.object(server, "delete_cognito_user") as delete_cognito,
        ):
            with self.assertRaises(HTTPException) as error:
                server.delete_account(USER_ID)
        self.assertEqual(error.exception.status_code, 409)
        delete_cognito.assert_not_called()

    def test_deletes_cognito_account_then_every_row_but_not_files(self):
        jobs = [{"job_id": "job-1"}, {"job_id": "job-2"}]
        sheets = [{"music_sheet_id": "sheet-1"}, {"music_sheet_id": "sheet-2"}]
        with (
            patch.object(server.db, "get_in_progress_job", return_value=None),
            patch.object(server, "delete_cognito_user") as delete_cognito,
            patch.object(server.db, "list_annotation_jobs", return_value=jobs),
            patch.object(server.db, "list_music_sheets", return_value=sheets),
            patch.object(server.db, "delete_annotation_job") as delete_job,
            patch.object(server.db, "delete_music_sheet") as delete_sheet,
            patch.object(server.db, "delete_user") as delete_user,
            patch.object(server, "storage") as storage,
        ):
            response = server.delete_account(USER_ID)

        self.assertEqual(response.status_code, 204)
        delete_cognito.assert_called_once_with(USER_ID)
        delete_job.assert_any_call("job-1")
        delete_job.assert_any_call("job-2")
        delete_sheet.assert_any_call("sheet-1")
        delete_sheet.assert_any_call("sheet-2")
        delete_user.assert_called_once_with(USER_ID)
        storage.delete_sheet_files.assert_not_called()
        storage.delete_job_files.assert_not_called()

    def test_local_delete_user_removes_the_row(self):
        db.create_user_if_missing("delete-account-test", "a@b.com", "A")
        db.delete_user("delete-account-test")
        self.assertIsNone(db.get_user("delete-account-test"))


class DeleteCognitoUserTests(unittest.TestCase):
    """auth.delete_cognito_user is a no-op unless Cognito is configured, so
    these force is_cognito_configured() to exercise the real boto3 path."""

    def test_noop_when_cognito_isnt_configured(self):
        with (
            patch.object(auth, "is_cognito_configured", return_value=False),
            patch.object(auth, "boto3") as boto3_mock,
        ):
            auth.delete_cognito_user(USER_ID)
        boto3_mock.client.assert_not_called()

    def test_looks_up_by_sub_since_a_federated_username_is_not_the_sub(self):
        """A Google/Apple sign-in's Username is "Google_<id>" etc, not the
        sub - AdminDeleteUser has to be called with that Username, found via
        ListUsers's sub filter, not with the sub itself."""
        client = MagicMock()
        client.list_users.return_value = {"Users": [{"Username": "Google_123"}]}
        with (
            patch.object(auth, "is_cognito_configured", return_value=True),
            patch.object(auth, "COGNITO_USER_POOL_ID", "pool-1"),
            patch.object(auth, "boto3") as boto3_mock,
        ):
            boto3_mock.client.return_value = client
            auth.delete_cognito_user(USER_ID)
        client.list_users.assert_called_once_with(UserPoolId="pool-1", Filter=f'sub = "{USER_ID}"')
        client.admin_delete_user.assert_called_once_with(UserPoolId="pool-1", Username="Google_123")

    def test_already_gone_is_not_an_error(self):
        client = MagicMock()
        client.list_users.return_value = {"Users": []}
        with (
            patch.object(auth, "is_cognito_configured", return_value=True),
            patch.object(auth, "COGNITO_USER_POOL_ID", "pool-1"),
            patch.object(auth, "boto3") as boto3_mock,
        ):
            boto3_mock.client.return_value = client
            auth.delete_cognito_user(USER_ID)  # must not raise
        client.admin_delete_user.assert_not_called()

    def test_a_cognito_error_becomes_a_502_rather_than_deleting_db_rows_anyway(self):
        client = MagicMock()
        client.list_users.side_effect = ClientError({"Error": {"Code": "InternalErrorException"}}, "ListUsers")
        with (
            patch.object(auth, "is_cognito_configured", return_value=True),
            patch.object(auth, "COGNITO_USER_POOL_ID", "pool-1"),
            patch.object(auth, "boto3") as boto3_mock,
        ):
            boto3_mock.client.return_value = client
            with self.assertRaises(HTTPException) as error:
                auth.delete_cognito_user(USER_ID)
        self.assertEqual(error.exception.status_code, 502)


if __name__ == "__main__":
    unittest.main()
