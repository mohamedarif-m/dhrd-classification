"""One module per slice of the /api surface, each exposing an APIRouter that
`app.main` includes. Route modules hold request/response shapes and guards
only; the work lives in `app.services`.
"""
