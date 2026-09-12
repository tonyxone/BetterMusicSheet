"""Load the existing signing secret without putting plaintext in Terraform."""
import os

import boto3

if "BACKEND_JWT_SECRET" not in os.environ:
    os.environ["BACKEND_JWT_SECRET"] = boto3.client("ssm").get_parameter(
        Name=os.environ["BACKEND_JWT_SECRET_PARAMETER"], WithDecryption=True)["Parameter"]["Value"]

from mangum import Mangum
from server import app

handler = Mangum(app, lifespan="off")
