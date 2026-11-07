"""Not Playwright. This is datum-render-shim 1.2.0, which provides only the
`playwright.sync_api` subset DATUM's datum_render.py calls, forwarded to Swarm's render
bridge (Electron's own Chromium). The name collision is deliberate and confined to Swarm's
private DATUM interpreter (runtime spec 3.2 (c))."""


def __getattr__(name):
    if name.startswith("__"):
        raise AttributeError(name)
    if name == "sync_api":  # `from playwright import sync_api` probes the attribute first
        import importlib
        return importlib.import_module(".sync_api", __name__)
    raise NotImplementedError(f"DATUM shim: playwright.{name} not supported")
