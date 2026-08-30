import logging
from datetime import datetime
from app.models.alert import Alert

logger = logging.getLogger("imd_service")
IMD_POLL_INTERVAL_SECONDS = 600

SAMPLE_IMD_BULLETINS = [
    {
        "title": "IMD Flash Flood Warning: Coastal Odisha & Gangetic West Bengal",
        "message": "Deep depression over North Bay of Bengal is likely to trigger extremely heavy rainfall (115-204mm) across Balasore, Bhadrak, Kendrapara, and East Midnapore. Coastal storm surge of 1.2m expected.",
        "severity": "Emergency",
        "target_region": "Odisha, West Bengal",
        "hazard_type": "Cyclone",
        "source": "IMD Ingestion Gateway"
    },
    {
        "title": "IMD Severe Weather Alert: Intense Heatwave across Rajasthan & Vidarbha",
        "message": "Day maximum temperatures exceeding 45°C predicted across Bikaner, Jaisalmer, Churu, and Nagpur. Red alert active for heat stroke vulnerability during peak afternoon hours 12:00-16:00.",
        "severity": "Warning",
        "target_region": "Rajasthan, Maharashtra",
        "hazard_type": "Heatwave",
        "source": "IMD Ingestion Gateway"
    },
    {
        "title": "IMD Flash Flood & Landslide Advisory: Uttarakhand & Himachal Pradesh",
        "message": "Active western disturbance likely to trigger torrential cloudbursts along Chamoli, Rudraprayag, and Kullu river catchments. Pilgrims and locals advised to stay off vulnerable valley highways.",
        "severity": "Emergency",
        "target_region": "Uttarakhand, Himachal Pradesh",
        "hazard_type": "Landslide",
        "source": "IMD Ingestion Gateway"
    }
]

class IMDService:
    async def ingest_once(self, db):
        try:
            for b in SAMPLE_IMD_BULLETINS:
                existing = db.query(Alert).filter(Alert.title == b["title"]).first()
                if not existing:
                    alert = Alert(
                        title=b["title"],
                        message=b["message"],
                        severity=b["severity"],
                        target_region=b["target_region"],
                        hazard_type=b["hazard_type"],
                        is_active=True,
                        source=b["source"]
                    )
                    db.add(alert)
            db.commit()
            logger.info("IMD Ingestion tick completed successfully.")
            return True
        except Exception as e:
            logger.error(f"IMD ingestion error: {e}")
            db.rollback()
            return False

imd_service = IMDService()
