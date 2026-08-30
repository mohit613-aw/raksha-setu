import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from app.config import BASE_DIR
from app.database.connection import Base, engine, SessionLocal
import app.models.user
import app.models.authority_application
import app.models.disaster
import app.models.incident_report
import app.models.duplicate_match
import app.models.shelter
import app.models.resource
import app.models.alert
import app.models.communication
import app.models.missing_person
import app.models.found_suggestion
import app.models.missing_person_audit_log
import app.models.notification
from app.services.imd_service import imd_service, IMD_POLL_INTERVAL_SECONDS

from app.api import (
    auth,
    admin,
    authority,
    disasters,
    reports,
    verification,
    shelters,
    resources,
    alerts,
    events,
    webhooks,
    communication,
    missing_persons,
    found_suggestions,
    notifications,
)

# Auto-create all SQLite tables on startup
Base.metadata.create_all(bind=engine)
from app.database.connection import auto_migrate_sqlite_columns
auto_migrate_sqlite_columns()

# Ensure uploads static directory exists
STATIC_UPLOADS_DIR = os.path.join(BASE_DIR, "static", "uploads")
os.makedirs(STATIC_UPLOADS_DIR, exist_ok=True)

FRONTEND_DIR = Path(BASE_DIR).parent / "frontend"

logger = logging.getLogger("uvicorn")


async def imd_background_poller():
    """
    Background worker that runs scheduled IMD alert ingestion cycles periodically.
    """
    while True:
        try:
            with SessionLocal() as db:
                await imd_service.ingest_once(db=db)
        except Exception as e:
            logger.error(f"IMD background ingestion cycle error: {e}")
        await asyncio.sleep(IMD_POLL_INTERVAL_SECONDS)


def seed_initial_data_if_empty():
    """
    Seeds initial realistic resources, alerts, and demo verification items if empty.
    """
    from app.models.resource import Resource
    from app.models.alert import Alert
    try:
        with SessionLocal() as db:
            # Seed resources if 0
            if db.query(Resource).count() == 0:
                sample_resources = [
                    Resource(item_name="Inflatable Rescue Boats", name="Inflatable Rescue Boats", category="Rescue Equipment", quantity_available=24, quantity_requested=0, delivery_location="Kendrapara Disaster Depot", status="Available"),
                    Resource(item_name="Emergency Drinking Water Packets (10,000L)", name="Emergency Drinking Water Packets (10,000L)", category="Water & Sanitation", quantity_available=1500, quantity_requested=0, delivery_location="Bhubaneswar State Relief Hub", status="Available"),
                    Resource(item_name="High-Capacity Water Purification Units", name="High-Capacity Water Purification Units", category="Water & Sanitation", quantity_available=8, quantity_requested=0, delivery_location="Cuttack Central Depot", status="Available"),
                    Resource(item_name="Medical First-Aid & Trauma Kits", name="Medical First-Aid & Trauma Kits", category="Medical Supplies", quantity_available=350, quantity_requested=0, delivery_location="SCB Medical Center Dispatch", status="Available"),
                    Resource(item_name="Diesel Generator 25kVA", name="Diesel Generator 25kVA", category="Power & Energy", quantity_available=12, quantity_requested=0, delivery_location="Puri Relief Hub", status="Available"),
                    Resource(item_name="Emergency Relief Tents (Family Size)", name="Emergency Relief Tents (Family Size)", category="Shelter & Bedding", quantity_available=0, quantity_requested=120, delivery_location="Balasore Coastal Evacuation Center", status="Pending"),
                    Resource(item_name="Chlorine Water Purification Tablets (50,000 count)", name="Chlorine Water Purification Tablets (50,000 count)", category="Water & Sanitation", quantity_available=0, quantity_requested=50000, delivery_location="Bhadrak High School Relief Camp", status="Pending"),
                ]
                db.add_all(sample_resources)
                db.commit()
                logger.info("Sample resources seeded.")

            # Seed alerts if 0
            if db.query(Alert).count() == 0:
                sample_alerts = [
                    Alert(
                        title="IMD Flash Flood Warning: Coastal Odisha & Gangetic West Bengal",
                        message="Deep depression over North Bay of Bengal is likely to trigger torrential rainfall (115-204mm) across Balasore, Bhadrak, Kendrapara, and East Midnapore.",
                        severity="Emergency",
                        target_region="Odisha, West Bengal",
                        hazard_type="Cyclone",
                        is_active=True,
                        source="IMD Ingestion Gateway"
                    ),
                    Alert(
                        title="River Brahmani & Baitarani Water Level Exceeding Danger Mark",
                        message="Central Water Commission alerts continuous discharge from upper catchments. Low-lying villages in Jajpur and Bhadrak urged to evacuate immediately.",
                        severity="Critical",
                        target_region="Odisha",
                        hazard_type="Flood",
                        is_active=True,
                        source="CWC Warning Division"
                    )
                ]
                db.add_all(sample_alerts)
                db.commit()
                logger.info("Sample alerts seeded.")

    except Exception as e:
        logger.error(f"Error seeding initial data: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Seed initial data & Start IMD background ingestion worker
    seed_initial_data_if_empty()
    poller_task = asyncio.create_task(imd_background_poller())
    logger.info("Raksha Setu IMD Background Poller started.")
    yield
    # Shutdown: Cancel worker
    poller_task.cancel()


app = FastAPI(
    title="Raksha Setu — Emergency Command & Early-Warning API",
    description="Real-time multi-agency situational awareness, geospatial GIS, IMD aggregation, Smart Incident Reporting, AI Needs Verification & Duplicate Engine.",
    version="2.3.0",
    lifespan=lifespan,
)

# Enable CORS for web frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=500)

# Mount static uploads directory for report & missing person images
app.mount("/static/uploads", StaticFiles(directory=STATIC_UPLOADS_DIR), name="uploads")
app.mount("/uploads", StaticFiles(directory=STATIC_UPLOADS_DIR), name="uploads_root")

# Mount frontend css and js directories if available
if FRONTEND_DIR.exists():
    css_dir = FRONTEND_DIR / "css"
    js_dir = FRONTEND_DIR / "js"
    if css_dir.exists():
        app.mount("/css", StaticFiles(directory=str(css_dir)), name="frontend_css")
    if js_dir.exists():
        app.mount("/js", StaticFiles(directory=str(js_dir)), name="frontend_js")
    # Serve root frontend assets (logo, favicon, images) directly
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR)), name="frontend_assets")

# Register API Routers
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(authority.router)
app.include_router(disasters.router)
app.include_router(reports.router)
app.include_router(verification.router)
app.include_router(shelters.router)
app.include_router(resources.router)
app.include_router(alerts.router)
app.include_router(events.router)
app.include_router(webhooks.router)
app.include_router(communication.router)
app.include_router(missing_persons.router)
app.include_router(found_suggestions.router)
app.include_router(notifications.router)


@app.get("/api")
def api_home():
    return {
        "system": "Raksha Setu Command Platform API",
        "version": "2.3.0",
        "status": "OPERATIONAL",
        "capabilities": [
            "Google Authentication & Identity",
            "Role-Based Access Control",
            "Smart Incident Reporting",
            "AI Needs Verification & Duplicate Engine",
            "Geospatial Heatmap",
            "IMD Aggregation",
            "SMS Fallback",
            "IVR Voice Telephony",
            "SSE Realtime Events",
        ],
    }


@app.get("/")
def home():
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return api_home()


@app.get("/index.html")
def get_index():
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return JSONResponse(status_code=404, content={"detail": "index.html not found"})


@app.get("/login.html")
@app.get("/login")
def get_login():
    login_file = FRONTEND_DIR / "login.html"
    if login_file.exists():
        return FileResponse(login_file)
    return JSONResponse(status_code=404, content={"detail": "login.html not found"})
