"""Thread scoping: a browser identity only ever sees its own threads."""

from app.services.threadstore import ThreadStore


def make_store(tmp_path):
    return ThreadStore(str(tmp_path))


def test_listing_is_scoped_to_owner(tmp_path):
    store = make_store(tmp_path)
    store.record("t1", "browser-a", "jobreq", "First chat")
    store.record("t2", "browser-b", "jobreq", "Someone else's chat")
    store.record("t3", "browser-a", "jobreq", "Second chat")

    a = store.list_for("browser-a")
    assert {r["thread_id"] for r in a} == {"t1", "t3"}
    b = store.list_for("browser-b")
    assert {r["thread_id"] for r in b} == {"t2"}
    assert store.list_for("browser-c") == []


def test_agent_key_filter(tmp_path):
    store = make_store(tmp_path)
    store.record("t1", "a", "jobreq", "x")
    store.record("t2", "a", "otheragent", "y")
    assert [r["thread_id"] for r in store.list_for("a", "jobreq")] == ["t1"]


def test_ownership_checks(tmp_path):
    store = make_store(tmp_path)
    store.record("t1", "a", "jobreq", "x")
    assert store.owns("t1", "a")
    assert not store.owns("t1", "b")
    assert not store.owns("missing", "a")


def test_record_existing_thread_keeps_owner_and_title(tmp_path):
    store = make_store(tmp_path)
    store.record("t1", "a", "jobreq", "Original title")
    store.record("t1", "a", "jobreq", "")  # follow-up turn
    rows = store.list_for("a")
    assert rows[0]["title"] == "Original title"


def test_persistence_across_restart(tmp_path):
    store = make_store(tmp_path)
    store.record("t1", "a", "jobreq", "Persisted")
    reopened = make_store(tmp_path)
    assert reopened.owns("t1", "a")
    assert reopened.list_for("a")[0]["title"] == "Persisted"


def test_rename(tmp_path):
    store = make_store(tmp_path)
    store.record("t1", "a", "jobreq", "Old")
    store.rename("t1", "New name")
    assert store.list_for("a")[0]["title"] == "New name"
