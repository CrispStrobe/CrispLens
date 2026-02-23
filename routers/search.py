"""
routers/search.py — Face search by person name.
"""
from fastapi import APIRouter, Query

router = APIRouter()


def _state():
    from fastapi_app import state
    return state


@router.get("")
def search_images(
    q:     str = Query('', description="Person name (partial match)"),
    limit: int = Query(50, ge=1, le=500),
):
    s = _state()
    if not q.strip():
        return []
    return s.engine.search_images_by_person(q.strip(), max_results=limit)
