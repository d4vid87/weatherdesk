// Say we are here, and listen for the one other box worth finding.
//
// Two jobs, one protocol. Advertising `_weatherdesk._tcp` is what lets Home Assistant's config
// flow offer this server rather than asking somebody to find its IP; browsing `_weatherlinklive`
// is what lets the setup wizard fill in a Davis console's address for them.

use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::sync::{Mutex, OnceLock};

/// Davis WeatherLink Live's own service type. The console advertises it out of the box.
const WLL: &str = "_weatherlinklive._tcp.local.";

fn found() -> &'static Mutex<Vec<(String, String)>> {
    static F: OnceLock<Mutex<Vec<(String, String)>>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(Vec::new()))
}

/// Consoles seen on the LAN, as (name, address). The wizard's "find my WeatherLink" button.
pub fn wll_hosts() -> Vec<(String, String)> {
    found().lock().map(|f| f.clone()).unwrap_or_default()
}

pub fn start(port: u16) {
    std::thread::spawn(move || {
        let Ok(daemon) = ServiceDaemon::new() else {
            // No mDNS is not a fault: plenty of networks block multicast, and every address in
            // this app can still be typed in by hand.
            return;
        };
        let host = crate::server::lan_ip();
        let info = ServiceInfo::new(
            "_weatherdesk._tcp.local.",
            "WeatherDesk",
            &format!("weatherdesk-{}.local.", host.replace('.', "-")),
            host.as_str(),
            port,
            &[("version", env!("CARGO_PKG_VERSION")), ("path", "/api/v1")][..],
        );
        match info {
            Ok(info) => {
                let _ = daemon.register(info);
            }
            Err(_) => eprintln!("weatherdesk: mDNS registration failed"),
        }

        // Browsing runs for the life of the process: a console that is switched on after us is
        // exactly the one somebody is standing there trying to set up.
        if let Ok(rx) = daemon.browse(WLL) {
            while let Ok(event) = rx.recv() {
                if let mdns_sd::ServiceEvent::ServiceResolved(s) = event {
                    let Some(addr) = s.get_addresses().iter().next().map(|a| a.to_string()) else { continue };
                    let name = s.get_fullname().split('.').next().unwrap_or("WeatherLink").to_string();
                    if let Ok(mut f) = found().lock() {
                        f.retain(|(_, a)| *a != addr);
                        f.push((name, addr));
                    }
                }
            }
        }
    });
}
