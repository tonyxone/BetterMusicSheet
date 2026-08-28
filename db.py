"""DynamoDB access for the four app tables (see infra/dynamodb.tf for schema).

Every function takes/returns plain Python dicts with DynamoDB's Decimal
numbers already converted to int/float, so callers (server.py) never touch
boto3 types directly.
"""
import os
import time
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

_dynamodb = boto3.resource("dynamodb", region_name=os.environ.get("COGNITO_REGION", "us-west-1"))

_users_table = _dynamodb.Table(os.environ["USERS_TABLE"])
_user_sub_table = _dynamodb.Table(os.environ["USER_SUB_TABLE"])
_music_sheet_table = _dynamodb.Table(os.environ["MUSIC_SHEET_TABLE"])
_annotation_job_table = _dynamodb.Table(os.environ["ANNOTATION_JOB_TABLE"])


def _clean(value):
    """Recursively convert DynamoDB's Decimal numbers to int/float for JSON."""
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    return value


# ---- users ----

def get_user(user_id):
    item = _users_table.get_item(Key={"user_id": user_id}).get("Item")
    return _clean(item) if item else None


def create_user_if_missing(user_id, email):
    """Idempotent - a condition expression avoids clobbering an existing row
    if two requests race (e.g. two tabs exchanging tokens at once)."""
    try:
        _users_table.put_item(
            Item={"user_id": user_id, "email": email, "display_name": email, "created_at": int(time.time())},
            ConditionExpression="attribute_not_exists(user_id)",
        )
    except _users_table.meta.client.exceptions.ConditionalCheckFailedException:
        pass


# ---- user_sub (subscription) ----

def get_user_sub(user_id):
    item = _user_sub_table.get_item(Key={"user_id": user_id}).get("Item")
    return _clean(item) if item else None


def create_free_sub_if_missing(user_id):
    try:
        _user_sub_table.put_item(
            Item={"user_id": user_id, "sub_type": "Free", "created_at": int(time.time())},
            ConditionExpression="attribute_not_exists(user_id)",
        )
    except _user_sub_table.meta.client.exceptions.ConditionalCheckFailedException:
        pass


# ---- music_sheet ----

def create_music_sheet(music_sheet_id, user_id, sheet_name):
    _music_sheet_table.put_item(Item={
        "music_sheet_id": music_sheet_id, "user_id": user_id,
        "sheet_name": sheet_name, "created_at": int(time.time()),
    })


def get_music_sheet(music_sheet_id):
    item = _music_sheet_table.get_item(Key={"music_sheet_id": music_sheet_id}).get("Item")
    return _clean(item) if item else None


def list_music_sheets(user_id):
    resp = _music_sheet_table.query(
        IndexName="user_id-index",
        KeyConditionExpression=Key("user_id").eq(user_id),
    )
    return _clean(resp["Items"])


# ---- annotation_job ----

def create_annotation_job(job_id, user_id, music_sheet_id, style, octave, font_size, dpi, auto_retry):
    now = int(time.time())
    _annotation_job_table.put_item(Item={
        "job_id": job_id, "user_id": user_id, "music_sheet_id": music_sheet_id,
        "status": "queued", "error": None, "stage": None, "labeled_groups": None,
        "style": style, "octave": octave, "font_size": Decimal(str(font_size)),
        "dpi": dpi, "auto_retry": auto_retry,
        "created_at": now, "updated_at": now,
    })


def get_annotation_job(job_id):
    item = _annotation_job_table.get_item(Key={"job_id": job_id}).get("Item")
    return _clean(item) if item else None


def update_annotation_job(job_id, **fields):
    """Partial update - only the given fields change. updated_at is always
    bumped, callers don't need to pass it."""
    fields["updated_at"] = int(time.time())
    expr_names = {f"#{k}": k for k in fields}
    expr_values = {f":{k}": v for k, v in fields.items()}
    _annotation_job_table.update_item(
        Key={"job_id": job_id},
        UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in fields),
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=expr_values,
    )


def count_active_jobs(user_id):
    """Jobs that count toward the Free-tier quota: everything except failed."""
    resp = _annotation_job_table.query(
        IndexName="user_id-index",
        KeyConditionExpression=Key("user_id").eq(user_id),
        FilterExpression="#s <> :failed",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":failed": "failed"},
    )
    return len(resp["Items"])


def list_annotation_jobs(user_id):
    resp = _annotation_job_table.query(
        IndexName="user_id-index",
        KeyConditionExpression=Key("user_id").eq(user_id),
        ScanIndexForward=False,  # newest first (sorted by the index's created_at range key)
    )
    return _clean(resp["Items"])
