"""Exercise credential loading without touching AWS or using real secrets."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'infra' / 'social-signin-env.sh'


def find_bash():
    """The bash to source the loader with. On Windows the bash.exe on PATH
    (System32, WindowsApps) is WSL's launcher, which runs the script inside
    Linux, where this checkout's Windows paths don't exist - so use Git for
    Windows' own bash, found next to git."""
    if os.name != 'nt':
        return shutil.which('bash')
    git = shutil.which('git')
    for folder in Path(git).resolve().parents if git else ():
        if (folder / 'bin' / 'bash.exe').is_file():
            return str(folder / 'bin' / 'bash.exe')
    return None


BASH = find_bash()


@unittest.skipUnless(BASH and shutil.which('jq'), 'requires bash and jq')
class DeploymentSecretLoaderTests(unittest.TestCase):
    def load(self, secret):
        with tempfile.TemporaryDirectory() as directory:
            aws = Path(directory) / 'aws'
            aws.write_text('#!/bin/sh\nprintf "%s" "$BMS_TEST_SECRET"\n')
            aws.chmod(0o755)
            environment = {key: value for key, value in os.environ.items() if not key.startswith('TF_VAR_')}
            environment.update(PATH=directory + os.pathsep + os.environ['PATH'],
                               BMS_TEST_SECRET=json.dumps(secret))
            # -e is how the Actions runner invokes its shell steps. No values
            # should reach Terraform when the source command fails.
            return subprocess.run([BASH, '-e', '-c',
                                   'source "$1"\nprintf "SIGNIN=%s\\nBILLING=%s\\n" "$TF_VAR_apple_cognito_key_id" "$TF_VAR_APPLE_KEY_ID"',
                                   'loader-test', str(SCRIPT)], env=environment,
                                  capture_output=True, text=True)

    def test_both_key_namespaces_survive_without_being_interchanged(self):
        result = self.load({'apple_cognito_services_id': 'test-service', 'apple_cognito_team_id': 'test-team',
                            'apple_cognito_key_id': 'signin-key', 'apple_cognito_private_key': 'test-signin-pem',
                            'APPLE_KEY_ID': 'billing-key', 'APPLE_ISSUER_ID': 'test-issuer',
                            'APPLE_PRIVATE_KEY': 'test-billing-pem'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('SIGNIN=signin-key\nBILLING=billing-key', result.stdout)
        self.assertNotIn('test-signin-pem', result.stdout)
        self.assertNotIn('test-billing-pem', result.stdout)

    def test_billing_keys_cannot_substitute_for_missing_signin_keys(self):
        result = self.load({'apple_cognito_services_id': 'test-service', 'apple_cognito_team_id': 'test-team',
                            'APPLE_KEY_ID': 'billing-key', 'APPLE_ISSUER_ID': 'test-issuer',
                            'APPLE_PRIVATE_KEY': 'test-billing-pem'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('apple_cognito_key_id', result.stderr)
        self.assertIn('apple_cognito_private_key', result.stderr)
        self.assertNotIn('Exported:', result.stdout)
        self.assertNotIn('BILLING=', result.stdout)

    def test_a_partial_billing_key_fails_before_export(self):
        result = self.load({'APPLE_KEY_ID': 'billing-key'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('APPLE_ISSUER_ID', result.stderr)
        self.assertIn('APPLE_PRIVATE_KEY', result.stderr)
        self.assertNotIn('Exported:', result.stdout)

    def test_empty_or_non_string_signin_credentials_are_rejected(self):
        for invalid in ['', None, 123]:
            with self.subTest(invalid=invalid):
                result = self.load({'apple_cognito_services_id': 'test-service', 'apple_cognito_team_id': 'test-team',
                                    'apple_cognito_key_id': invalid, 'apple_cognito_private_key': 'test-signin-pem'})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('apple_cognito_key_id', result.stderr)

    def test_a_secret_with_only_the_old_signin_names_is_refused(self):
        # Loading it would leave Sign in with Apple empty, and Terraform would
        # delete the live provider.
        result = self.load({'apple_services_id': 'test-service', 'apple_team_id': 'test-team',
                            'apple_key_id': 'signin-key', 'apple_private_key': 'test-signin-pem',
                            'google_client_id': 'test-google', 'google_client_secret': 'test-secret'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('old apple_* Sign in with Apple names', result.stderr)
        self.assertNotIn('Exported:', result.stdout)

    def test_old_names_alongside_the_new_ones_are_ignored(self):
        result = self.load({'apple_cognito_services_id': 'test-service', 'apple_cognito_team_id': 'test-team',
                            'apple_cognito_key_id': 'signin-key', 'apple_cognito_private_key': 'test-signin-pem',
                            'apple_key_id': 'old-key', 'apple_private_key': 'old-pem'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('SIGNIN=signin-key', result.stdout)

    def test_deployments_without_apple_configuration_still_load_other_providers(self):
        result = self.load({'google_client_id': 'test-google', 'google_client_secret': 'test-secret'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('TF_VAR_google_client_id', result.stdout)
        self.assertNotIn('test-secret', result.stdout)
