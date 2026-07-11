from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import config

security = HTTPBearer(auto_error=False)


def check_token(token: str | None) -> bool:
    return bool(token) and bool(config.WIKI_PASSWORD) and token == config.AUTH_TOKEN


async def require_auth(creds: HTTPAuthorizationCredentials | None = Depends(security)) -> bool:
    if not creds or not check_token(creds.credentials):
        raise HTTPException(401, "Unauthorized")
    return True
