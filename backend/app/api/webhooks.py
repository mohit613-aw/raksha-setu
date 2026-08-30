from fastapi import APIRouter
router = APIRouter(prefix="/webhooks", tags=["Webhooks"])

@router.post("/imd")
def webhook_imd():
    return {"status": "received"}
