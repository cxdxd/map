#!/usr/bin/env python3
"""AeroAtlas local server: static site plus file-backed accounts.

Run:  runtime\\python.exe server.py
All account data lives in storage/accounts.json (PBKDF2 password hashes).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import posixpath
import re
import secrets
import threading
import time
import webbrowser
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
STORAGE = ROOT / "storage"
ACCOUNTS_FILE = STORAGE / "accounts.json"
SESSIONS_FILE = STORAGE / "sessions.json"
AIRPORTS_FILE = ROOT / "data" / "airports.js"

SESSION_COOKIE = "aero_session"
SESSION_TTL = 7 * 24 * 60 * 60
PBKDF2_ITERATIONS = 210_000
MAX_BODY = 2 * 1024 * 1024
MAX_FAVORITES = 25000
USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")
CODE_RE = re.compile(r"^[A-Z]{4}$")

LOCK = threading.RLock()


def load_valid_codes():
    try:
        raw = AIRPORTS_FILE.read_text(encoding="utf-8")
        payload = raw.split("=", 1)[1].strip().rstrip(";").strip()
        data = json.loads(payload)
        return {str(row[0]).upper() for row in data["airports"]}
    except Exception as error:  # pragma: no cover - defensive
        print("warning: could not load airport codes:", error)
        return None


VALID_CODES = load_valid_codes()


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def ensure_storage() -> None:
    STORAGE.mkdir(parents=True, exist_ok=True)


def read_json_file(path: Path, fallback):
    if not path.exists():
        return fallback
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as error:
        raise RuntimeError(f"无法读取 {path.name}: {error}") from error


def atomic_write(path: Path, payload) -> None:
    ensure_storage()
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def load_accounts():
    data = read_json_file(ACCOUNTS_FILE, {"version": 1, "users": {}})
    if not isinstance(data, dict) or not isinstance(data.get("users"), dict):
        raise RuntimeError("accounts.json 格式不正确")
    return data


def load_sessions():
    data = read_json_file(SESSIONS_FILE, {"sessions": {}})
    sessions = data.get("sessions") if isinstance(data, dict) else None
    if not isinstance(sessions, dict):
        return {"sessions": {}}
    now = time.time()
    cleaned = {token: value for token, value in sessions.items()
               if isinstance(value, dict) and value.get("expires", 0) > now}
    return {"sessions": cleaned}


ACCOUNTS = load_accounts()
SESSIONS = load_sessions()


def save_accounts() -> None:
    atomic_write(ACCOUNTS_FILE, ACCOUNTS)


def save_sessions() -> None:
    atomic_write(SESSIONS_FILE, SESSIONS)


def hash_password(password: str):
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return base64.b64encode(salt).decode("ascii"), base64.b64encode(digest).decode("ascii")


def verify_password(password: str, record: dict) -> bool:
    try:
        salt = base64.b64decode(record["salt"])
        expected = base64.b64decode(record["hash"])
        iterations = int(record.get("iterations", PBKDF2_ITERATIONS))
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
        return hmac.compare_digest(digest, expected)
    except Exception:
        return False


def sanitize_favorites(value):
    if not isinstance(value, list):
        return []
    result = []
    seen = set()
    for item in value[:MAX_FAVORITES * 2]:
        code = str(item or "").strip().upper()
        if not CODE_RE.match(code) or code in seen:
            continue
        if VALID_CODES is not None and code not in VALID_CODES:
            continue
        seen.add(code)
        result.append(code)
        if len(result) >= MAX_FAVORITES:
            break
    return result


def session_for(token: str):
    if not token:
        return None
    now = time.time()
    with LOCK:
        session = SESSIONS["sessions"].get(token)
        if not session:
            return None
        if float(session.get("expires", 0)) <= now:
            SESSIONS["sessions"].pop(token, None)
            save_sessions()
            return None
        username = session.get("username")
        if username not in ACCOUNTS["users"]:
            SESSIONS["sessions"].pop(token, None)
            save_sessions()
            return None
        return session


def create_session(username_key: str) -> str:
    token = secrets.token_urlsafe(32)
    with LOCK:
        SESSIONS["sessions"][token] = {
            "username": username_key,
            "expires": time.time() + SESSION_TTL,
            "created": now_iso(),
        }
        save_sessions()
    return token


def delete_session(token: str) -> None:
    if not token:
        return
    with LOCK:
        if SESSIONS["sessions"].pop(token, None) is not None:
            save_sessions()


def public_user(record: dict) -> dict:
    return {
        "username": record.get("username", ""),
        "createdAt": record.get("createdAt", ""),
        "favoriteCount": len(record.get("favorites", [])),
    }


def user_payload(record: dict) -> dict:
    return {"user": public_user(record), "favorites": record.get("favorites", [])}


class Handler(SimpleHTTPRequestHandler):
    server_version = "AeroAtlasLocal/1.0"
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # ---------- static ----------
    PUBLIC_DIRS = ("/assets/", "/data/", "/vendor/", "/shots/")
    PUBLIC_FILES = {"/index.html", "/readme.md", "/airports24-favorites.json"}

    def _allowed(self, path: str) -> bool:
        lowered = path.lower()
        return lowered in self.PUBLIC_FILES or lowered.startswith(self.PUBLIC_DIRS)

    def list_directory(self, path):  # no directory listings
        self.send_error(HTTPStatus.NOT_FOUND, "File not found")
        return None

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.path.endswith((".html", ".js", ".css", ".json")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _static(self, method: str):
        path = self._static_path(self.path)
        if not self._allowed(path):
            return self.send_error(HTTPStatus.NOT_FOUND, "File not found")
        self.path = path
        if method == "GET":
            return super().do_GET()
        return self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)

    def _static_path(self, raw_path: str) -> str:
        path = unquote(urlparse(raw_path).path).replace("\\", "/")
        path = "/" + path.lstrip("/")
        path = posixpath.normpath(path)
        return "/index.html" if path == "/" else path

    # ---------- HTTP ----------
    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self._handle_api("GET", path)
        return self._static("GET")

    def do_HEAD(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)
        clean = self._static_path(self.path)
        if not self._allowed(clean):
            return self.send_error(HTTPStatus.NOT_FOUND, "File not found")
        self.path = clean
        return super().do_HEAD()

    def do_POST(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self._handle_api("POST", path)
        return self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)

    def do_PUT(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self._handle_api("PUT", path)
        return self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Allow", "GET, POST, PUT, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    # ---------- helpers ----------
    def _cookie_token(self) -> str:
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return ""
        morsel = cookie.get(SESSION_COOKIE)
        return morsel.value if morsel else ""

    def _current_user(self):
        session = session_for(self._cookie_token())
        if not session:
            return None
        return ACCOUNTS["users"].get(session["username"])

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            raise ApiError(400, "请求内容为空")
        if length > MAX_BODY:
            raise ApiError(413, "请求内容过大")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception as error:
            raise ApiError(400, "JSON 格式不正确") from error
        if not isinstance(data, dict):
            raise ApiError(400, "JSON 格式不正确")
        return data

    def _check_origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return
        if urlparse(origin).netloc != self.headers.get("Host", ""):
            raise ApiError(403, "来源不匹配")

    def _send_json(self, status: int, payload: dict, cookie: str | None = None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _session_cookie(self, token: str) -> str:
        return f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL}"

    def _expired_cookie(self) -> str:
        return f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"

    def _handle_api(self, method: str, path: str):
        try:
            self._check_origin()
            routes = {
                ("GET", "/api/health"): self._api_health,
                ("GET", "/api/me"): self._api_me,
                ("POST", "/api/register"): self._api_register,
                ("POST", "/api/login"): self._api_login,
                ("POST", "/api/logout"): self._api_logout,
                ("GET", "/api/favorites"): self._api_get_favorites,
                ("PUT", "/api/favorites"): self._api_put_favorites,
            }
            handler = routes.get((method, path))
            if not handler:
                raise ApiError(404, "接口不存在")
            handler()
        except ApiError as error:
            self._send_json(error.status, {"error": error.message})
        except Exception as error:
            print("api error:", repr(error))
            self._send_json(500, {"error": "服务器内部错误"})

    # ---------- API ----------
    def _api_health(self):
        self._send_json(200, {"ok": True, "service": "aeroatlas-local", "version": 1})

    def _api_me(self):
        user = self._current_user()
        if not user:
            self._send_json(200, {"user": None, "favorites": []})
            return
        self._send_json(200, user_payload(user))

    def _api_register(self):
        data = self._read_json()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        if not USERNAME_RE.match(username):
            raise ApiError(400, "用户名需为 3-20 位字母、数字或下划线")
        if len(password) < 6 or len(password) > 128:
            raise ApiError(400, "密码长度需为 6-128 位")
        favorites = sanitize_favorites(data.get("favorites", []))
        key = username.lower()
        with LOCK:
            if key in ACCOUNTS["users"]:
                raise ApiError(409, "这个用户名已经被注册")
            salt, digest = hash_password(password)
            record = {
                "username": username,
                "salt": salt,
                "hash": digest,
                "iterations": PBKDF2_ITERATIONS,
                "createdAt": now_iso(),
                "favorites": favorites,
            }
            ACCOUNTS["users"][key] = record
            save_accounts()
        token = create_session(key)
        self._send_json(201, user_payload(record), self._session_cookie(token))

    def _api_login(self):
        data = self._read_json()
        username = str(data.get("username", "")).strip()
        password = str(data.get("password", ""))
        key = username.lower()
        with LOCK:
            record = ACCOUNTS["users"].get(key)
        if not record or not verify_password(password, record):
            raise ApiError(401, "用户名或密码错误")
        token = create_session(key)
        self._send_json(200, user_payload(record), self._session_cookie(token))

    def _api_logout(self):
        delete_session(self._cookie_token())
        self._send_json(200, {"ok": True}, self._expired_cookie())

    def _api_get_favorites(self):
        user = self._current_user()
        if not user:
            raise ApiError(401, "请先登录")
        self._send_json(200, {"favorites": user.get("favorites", [])})

    def _api_put_favorites(self):
        user = self._current_user()
        if not user:
            raise ApiError(401, "请先登录")
        data = self._read_json()
        favorites = sanitize_favorites(data.get("favorites", []))
        with LOCK:
            user["favorites"] = favorites
            save_accounts()
        self._send_json(200, {"ok": True, "count": len(favorites)})


def main():
    parser = argparse.ArgumentParser(description="AeroAtlas local account server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    ensure_storage()
    ThreadingHTTPServer.allow_reuse_address = True
    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as error:
        print(f"无法启动服务器：{error}")
        print(f"端口 {args.port} 可能已被占用。")
        return 1

    url = f"http://{args.host if args.host != '0.0.0.0' else '127.0.0.1'}:{args.port}/"
    print("=" * 58)
    print("AeroAtlas 本地账号服务已启动")
    print(f"地址：{url}")
    print(f"账号文件：{ACCOUNTS_FILE}")
    print("按 Ctrl+C 停止服务")
    print("=" * 58)
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在停止…")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
