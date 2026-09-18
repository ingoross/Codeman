---
'aicodeman': patch
---

**Drop a pdf on the terminal and it attaches, like an image always did.** Dropping anything but an image used to answer "Only image files are supported"; the drop handler now takes the whole batch, splits it by MIME, and sends each file to the endpoint that suits it — images keep the existing downscale-and-re-encode path to `/paste-image`, everything else goes verbatim to `/upload-file`. All saved paths are then inserted into the terminal in one shot, in the order dropped, so a mixed drop of a screenshot and a spreadsheet comes out as one line the agent can act on. A dropped folder is reported as skipped instead of arriving as a mysterious "Empty file", and a failed upload now shows the server's reason (too large, rate limited, remote session) rather than a bare "1 failed" that sent you to the browser console.

Attaching is no longer invisible. Drag-and-drop is undiscoverable and impossible to perform on a touch screen, so there are now two visible entry points, each placed where that platform already keeps its input controls:

- **Desktop**: a paperclip in the bottom toolbar, beside the voice mic, opening the native picker. Unlike the mic it stays visible below 1024px — a narrow window still has no other way to attach — and hides on touch devices, where the bottom edge is the system gesture zone.
- **Phone/tablet**: a **📎 File** button in the paste dialog the keyboard accessory already opens, next to **🖼 Image**. They stay separate buttons on purpose: the Image button's `accept="image/*"` is what makes iOS and Android offer the camera and the photo library rather than only the file browser, and folding the two together would take the camera away to save a tap.

`/upload.html` is deliberately untouched. It is the phone *screenshot* flow — no session id, writes to `~/.codeman/screenshots`, hands back a path to copy — so it has no session working directory to attach to and nothing to insert into.
