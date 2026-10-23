# Route2Root — Unified Admin Operations Dashboard

A single admin login opens one master dashboard. Donor Desk, Rider Desk, Shelter Desk, Orders & Deliveries, Live Map, Reports, Approvals and Failure Simulator are all available from the left sidebar. The app uses Express + SQLite and server-side authorization.

## Run locally

```powershell
npm install
npm start
```

Open http://localhost:3000.

## Admin demo login

- Email: `admin@demo.in`
- Password: `demo1234`

Only admin accounts can log in through the website. Demo donor, rider and shelter records are managed by the admin console; there are no separate donor/rider/shelter login screens.

On a fresh database, sample shelters, riders, donations and delivery batches are created automatically. To reset the local demo database, stop the server, delete `route2root.db`, then run `npm start` again.

## Main capabilities

- One dashboard with left-side navigation for all operational areas.
- Donation creation with type, quantity, pickup location, packaging and safety window.
- Capacity-aware batch splitting, shelter demand and compatibility checks.
- Rider status, ETA, pickup/delivery OTPs and live map.
- Reservation expiry, unresponsive rider handling, traffic/ETA recovery and shelter closure recovery.
- Safety holds for deliveries that cannot be completed before the original deadline.
- Failure simulator and audit log for judging.

## Prototype limitations

ETAs are estimates based on straight-line distance, road factor and assumed speed; no live traffic provider is connected. The 75-minute cooked-meal window is only demo data, not universal food-safety advice. Validate handling rules before any real-world deployment.

## Operational logic updates

- Admin Rider Desk now includes an incoming-order inbox with Accept and Reject/Reassign actions for reserved batches.
- Admin can mark a rider offline/online or unresponsive/responsive. Marking a rider unavailable triggers immediate recovery attempts for their active assignments.
- Reservation countdowns are shown in the Rider Desk. Reservations expire after 10 minutes without confirmation; the 15-minute stale/unresponsive check remains a separate safety rule.
- The live event stream accepts the session token supplied by the browser's EventSource connection, allowing dashboard refreshes after backend changes.
- Delivery deadlines are never reset during recovery. If no compatible replacement can meet the deadline, the batch goes to SafetyHold.

This remains a local prototype: ETAs use straight-line distance and an assumed speed, not live traffic. Admin actions in Rider Desk simulate operational controls; they are not push notifications to a real rider's phone.
