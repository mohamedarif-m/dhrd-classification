"""/api/template/{key} - the blank-template proxy. No network: the COS calls
run over an httpx.MockTransport, the same way test_threadstore_cos.py does it.

What is pinned here is the contract the UI's download chip depends on: the
allow-list is the whole reachable surface, the filename in the disposition is
the vendor's (odd spacing and all), an immutable object is cacheable, and every
way the store can fail turns into a status rather than a traceback.
"""

import importlib
import sys
import types

import httpx
import pytest
from fastapi.testclient import TestClient

BUCKET_ENV = {
    "COS_API_KEY": "secret-key",
    "COS_ENDPOINT": "https://s3.us-east.cloud-object-storage.appdomain.cloud",
    "COS_BUCKET": "tko-bucket",
    "COS_OBJECT": "tko-agents-ui/threads.json",
}

TEMPLATE_BYTES = b"PK\x03\x04" + b"x" * 4096
XLSX_MIME = ("application/vnd.openxmlformats-officedocument"
             ".spreadsheetml.sheet")


class FakeCos:
    """IAM mint + one object GET, over a mock transport."""

    def __init__(self, *, obj: bytes | None = TEMPLATE_BYTES,
                 iam_status: int = 200, get_status: int = 200,
                 raise_on: str | None = None) -> None:
        self.obj = obj
        self.iam_status = iam_status
        self.get_status = get_status
        self.raise_on = raise_on          # "iam" | "get" | None
        self.mints = 0
        self.gets: list[str] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/identity/token"):
            self.mints += 1
            if self.raise_on == "iam":
                raise httpx.ConnectError("iam unreachable", request=request)
            if self.iam_status != 200:
                return httpx.Response(self.iam_status, text="nope")
            return httpx.Response(200, json={"access_token": "tok-1",
                                             "expires_in": 3600})
        self.gets.append(str(request.url))
        if self.raise_on == "get":
            raise httpx.ConnectError("cos unreachable", request=request)
        assert request.headers["Authorization"] == "Bearer tok-1"
        if self.get_status != 200 or self.obj is None:
            return httpx.Response(404 if self.obj is None else self.get_status,
                                  text="err")
        return httpx.Response(200, content=self.obj)

    def install(self, monkeypatch, template_mod) -> "FakeCos":
        """Bind the module's httpx to a client that speaks to this fake.

        Only the two names the route uses are shimmed, so a call the route
        makes through any OTHER part of httpx would fail loudly rather than
        escape to the network.
        """
        transport = httpx.MockTransport(self.handle)

        def _client(**kw):
            kw.pop("transport", None)
            return httpx.AsyncClient(transport=transport, **kw)

        monkeypatch.setattr(
            template_mod, "httpx",
            types.SimpleNamespace(AsyncClient=_client,
                                  HTTPError=httpx.HTTPError),
            raising=True)
        return self


def _app(tmp_path, monkeypatch, *, cos: bool = True):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.delenv("TKO_ENV_FILE", raising=False)
    for key, value in BUCKET_ENV.items():
        if cos:
            monkeypatch.setenv(key, value)
        else:
            monkeypatch.delenv(key, raising=False)
    for mod in [m for m in list(sys.modules) if m.startswith("app")]:
        del sys.modules[mod]
    main = importlib.import_module("app.main")
    return (TestClient(main.app),
            importlib.import_module("app.routes.template"))


@pytest.fixture()
def configured(tmp_path, monkeypatch):
    return _app(tmp_path, monkeypatch)


def test_template_downloads_with_the_vendor_filename(configured, monkeypatch):
    client, template = configured
    fake = FakeCos().install(monkeypatch, template)
    r = client.get("/api/template/eib")
    assert r.status_code == 200
    assert r.content == TEMPLATE_BYTES
    assert r.headers["content-type"].startswith(XLSX_MIME)
    assert r.headers["content-disposition"] == (
        'attachment; filename="EIB Load Template _TKO_v41.0.xlsx"')
    # The object is fetched from THIS agent's state prefix, url-encoded whole
    # so the spaces and the slashes survive.
    assert len(fake.gets) == 1
    assert "agent-state%2Feibc%2Ftemplate%2F" in fake.gets[0]


def test_the_download_needs_no_identity_header(configured, monkeypatch):
    """DELIBERATE, and the reason the route has no client_id() call: the chip
    is a bare <a download> anchor and an anchor cannot send X-TKO-Client. A
    gate here would break the link, and there is nothing behind it to protect -
    every allow-listed object is a blank vendor template."""
    client, template = configured
    FakeCos().install(monkeypatch, template)
    assert client.get("/api/template/eib").status_code == 200


def test_an_immutable_template_is_cacheable_and_fetched_once(configured,
                                                             monkeypatch):
    """The version is IN the filename, so a new template is a new URL. That is
    what makes both caches safe: the browser's max-age and the process memo."""
    client, template = configured
    fake = FakeCos().install(monkeypatch, template)
    first = client.get("/api/template/eib")
    assert first.headers["cache-control"] == "public, max-age=3600"
    second = client.get("/api/template/eib")
    assert second.content == first.content == TEMPLATE_BYTES
    assert len(fake.gets) == 1, "the second request never reached COS"
    assert fake.mints == 1, "nor minted a second token"


def test_an_unknown_template_key_is_404(configured, monkeypatch):
    """`key` is looked up in the allow-list and never concatenated into an
    object URL, so no caller can walk the bucket."""
    client, template = configured
    fake = FakeCos().install(monkeypatch, template)
    assert client.get("/api/template/nope").status_code == 404
    assert client.get("/api/template/eibc").status_code == 404
    assert fake.gets == [], "an unknown key does not reach the store at all"


def test_a_missing_object_is_404(configured, monkeypatch):
    client, template = configured
    FakeCos(obj=None).install(monkeypatch, template)
    assert client.get("/api/template/eib").status_code == 404


def test_a_forbidden_object_is_502_not_404(configured, monkeypatch):
    """403 is a credential problem on OUR side. Reporting it as 404 would tell
    the user the template does not exist when it does."""
    client, template = configured
    FakeCos(get_status=403).install(monkeypatch, template)
    assert client.get("/api/template/eib").status_code == 502


def test_a_transport_error_on_the_object_is_502(configured, monkeypatch):
    """The GET raising rather than answering - a DNS failure, a reset. Without
    the except clause this is a 500 with a traceback in the log."""
    client, template = configured
    FakeCos(raise_on="get").install(monkeypatch, template)
    assert client.get("/api/template/eib").status_code == 502


def test_a_transport_error_on_the_iam_mint_is_502(configured, monkeypatch):
    """Same for the token call, which is the FIRST thing that can fail."""
    client, template = configured
    FakeCos(raise_on="iam").install(monkeypatch, template)
    assert client.get("/api/template/eib").status_code == 502


def test_a_refused_iam_mint_is_502(configured, monkeypatch):
    client, template = configured
    FakeCos(iam_status=400).install(monkeypatch, template)
    assert client.get("/api/template/eib").status_code == 502


def test_unconfigured_storage_is_503(tmp_path, monkeypatch):
    """No COS env vars: the endpoint says the deployment is missing something,
    which is a different answer from 'that template does not exist'."""
    client, _ = _app(tmp_path, monkeypatch, cos=False)
    assert client.get("/api/template/eib").status_code == 503
    # ...and an unknown key is still 404 even unconfigured: the allow-list is
    # checked first, so a probe learns nothing about the deployment.
    assert client.get("/api/template/nope").status_code == 404
