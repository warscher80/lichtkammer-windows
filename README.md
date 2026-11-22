# Lichtkammer

Desktop-App zum Sichten und Entwickeln von Fotos. Sie ist an Lightroom angelehnt, arbeitet aber automatisch: unscharfe Bilder und Duplikate wandern in einen eigenen Bereich, die behaltenen Fotos bekommen eine nicht-destruktive Entwicklung. Originale werden nie gelöscht und nie überschrieben.

Läuft unter Windows, macOS und zum Entwickeln auch unter Linux.

## Was die App tut

- **Import.** Ordner oder einzelne Dateien, per Dialog oder per Drag-and-drop. JPG, PNG, WEBP, TIFF und GIF werden direkt gelesen. CR2, CR3, NEF, ARW, DNG, RAF, ORF und RW2 werden aus den Sensordaten entwickelt (Demosaik, Weißabgleich der Kamera, sRGB). Gelingt das nicht, bleibt die eingebettete Vorschau als Ausweg, gekennzeichnet mit „Vorschau“. Die RAW-Datei selbst wird nie geschrieben.
- **Aussortieren.** Schärfe über die Varianz eines Laplace-Filters, auf einer Skala von 0 bis 100. Duplikate und Beinahe-Duplikate über einen 64-Bit-dHash. In jeder Gruppe bleibt das schärfste Bild, bei Gleichstand das mit mehr Pixeln. Der Rest liegt unter **Aussortiert**, in den Bereichen **Unscharf** und **Duplikate**.
- **Nichts wird gelöscht.** „Wiederherstellen“ holt ein Foto zurück in die Bibliothek. „Kopien ablegen…“ schreibt Kopien nach `Aussortiert/Unscharf` und `Aussortiert/Duplikate`. „Aus der Bibliothek nehmen“ entfernt nur den Katalogeintrag.
- **Entwickeln.** Automatische Belichtung, Weißabgleich an neutralen Flächen, eine weiche Tonkurve mit Lichter-Rückgewinnung und Tiefenanhebung, Klarheit (lokaler Kontrast), Dynamik mit Schutz von Hauttönen, kantenschonende Rauschreduzierung und zurückhaltende Schärfung. Die Werte liegen auf Reglern. Vergleich Vorher/Nachher. Die Bearbeitung steckt nur im Katalog.
- **Export.** JPG oder PNG in einen Zielordner, in voller Auflösung (sehr große Dateien werden auf 10.000 Pixel an der langen Kante begrenzt). Dateiname mit dem Zusatz `_lichtkammer`.

Die Schwellen für Unschärfe und Duplikate stehen links in der Bibliothek und wirken sofort auf den Katalog, ohne die Dateien neu zu lesen.

## Voraussetzungen

- [Node.js](https://nodejs.org) 20 oder neuer (empfohlen: 22)
- npm
- Unter Windows und macOS genügt das für die Entwicklung. Installer werden auf dem jeweiligen System gebaut.

## Start

```bash
npm install
npm run dev
```

Beim ersten Start ist die Bibliothek leer. Oben auf **Beispiele** laden, oder einen eigenen Ordner auf das Fenster ziehen.

Die Beispielbilder liegen in `beispiele/` und decken die Fälle ab: scharfes Motiv mit exakter Kopie und Beinahe-Duplikat, zwei unscharfe Aufnahmen, ein unterbelichtetes Bild, ein Farbstich, ein flaues Motiv, eine `.ARW`-Hülle nur mit Vorschau und eine echte Nikon-NEF (`13-nikon-d70s.NEF`), die aus den Sensordaten entwickelt wird. Herkunft und Lizenzen stehen in `beispiele/QUELLEN.md`.

Die Pipeline lässt sich ohne Fenster prüfen:

```bash
npm run verify
```

Das Skript sichtet die Beispiele, prüft Unschärfe, Duplikate, Belichtung und Weißabgleich und stellt sicher, dass keine Originaldatei verändert wurde.

## Bedienung

| Ansicht | Inhalt |
| --- | --- |
| Bibliothek | Raster der behaltenen Fotos. Doppelklick öffnet die Entwicklung. |
| Aussortiert | Unscharf und Duplikate, jeweils mit Wiederherstellen. |
| Entwickeln | Großes Bild, Vergleich, Regler. `\` gedrückt halten zeigt das unbearbeitete Foto. Doppelklick auf eine Bezeichnung setzt den Auto-Wert. |

Die Schärfe-Schwelle und die Duplikat-Toleranz gelten für die ganze Bibliothek. Eine niedrigere Schwelle sortiert nur deutlich weiche Bilder aus.

## Installer bauen

Native Bildbausteine werden für das Betriebssystem gebaut, auf dem `npm install` läuft. Deshalb entsteht der Windows-Installer unter Windows und der macOS-Installer auf einem Mac.

### Windows

In PowerShell, im Projektordner:

```powershell
npm install
npm run dist:win
```

Oder `scripts\build-win.ps1`. Ergebnis: `release/Lichtkammer-<version>-Setup.exe`.

Der Installer fragt nach dem Zielordner. Die Builds sind unsigniert. SmartScreen zeigt beim ersten Start „Windows hat den PC geschützt“. Dann **Weitere Informationen** und **Trotzdem ausführen**.

Eine spätere Signatur braucht keine Änderung am Code: `CSC_LINK` auf die PFX-Datei oder deren Base64-Inhalt setzen und `CSC_KEY_PASSWORD` auf das Passwort. Solange die Variablen fehlen, bleibt der Installer unsigniert (`CSC_IDENTITY_AUTO_DISCOVERY=false`).

### macOS

Im Terminal, auf einem Mac:

```bash
chmod +x scripts/build-mac.sh
./scripts/build-mac.sh
```

`npm run dist:mac` baut dieselben Dateien und signiert ebenfalls, wenn das Zertifikat schon im Schlüsselbund liegt. Das Shell-Skript brauchst du, sobald `APPLE_API_KEY_CONTENT` oder leere CI-Variablen im Spiel sind. Es entstehen DMG und ZIP für Intel (`x64`) und Apple Silicon (`arm64`) in `release/`, jeweils mit der Architektur im Dateinamen (`Lichtkammer-1.0.0-arm64.dmg` und `Lichtkammer-1.0.0-x64.dmg`).

Ohne Apple-Signatur lässt sich die App nicht per Doppelklick öffnen. Im Finder **Rechtsklick auf Lichtkammer → Öffnen**, danach im Dialog noch einmal **Öffnen**.

### macOS signieren und notarisieren (Developer ID)

Dafür ist das **Developer-ID-Zertifikat** des bezahlten Accounts zuständig. Es ist ein anderes Zertifikat als das der iPhone-App: die iPhone-Installation über Xcode nutzt „Apple Development“, TestFlight nutzt „Apple Distribution“, die DMG außerhalb des Mac App Store nutzt **Developer ID Application**. Ein Developer-ID-Installer-Zertifikat brauchst du für die DMG nicht.

1. Zertifikat anlegen. In Xcode: **Settings → Accounts → dein Team → Manage Certificates → + → Developer ID Application**. Das darf der Account Holder. Alternativ auf [developer.apple.com](https://developer.apple.com/account/resources/certificates/list) unter Certificates **Developer ID Application** erzeugen und die Zwischenzertifikate von Apple im Schlüsselbund behalten.
2. Für einen zweiten Mac oder für CI den Eintrag im Schlüsselbund öffnen und **Zertifikat plus privaten Schlüssel** als `.p12` exportieren. Das Passwort dieser Datei ist `CSC_KEY_PASSWORD`. Die `.p12` bleibt außerhalb des Repositories.
3. Bauen. Liegt „Developer ID Application“ im Schlüsselbund des Macs, signiert `./scripts/build-mac.sh` von selbst. Für die exportierte Datei oder die CI vorher setzen, ohne die Werte ins Repository zu schreiben:

```bash
export CSC_LINK="$HOME/geheim/DeveloperID.p12"   # oder der Base64-Inhalt der Datei
export CSC_KEY_PASSWORD="das-p12-passwort"
```

4. Notarisieren, damit Gatekeeper die App ohne Rechtsklick öffnet. Eine der beiden Varianten reicht. electron-builder stapelt das Ticket nach dem Signieren an die App (`notarytool`).

Apple-ID:

```bash
export APPLE_ID="name@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="DEINE_TEAM_ID"
```

Das App-Passwort legst du unter [appleid.apple.com](https://appleid.apple.com) bei den app-spezifischen Passwörtern an. `APPLE_TEAM_ID` ist dieselbe zehnstellige Team-ID wie bei der iPhone-App.

App Store Connect API, dieselbe `.p8` wie für TestFlight:

```bash
export APPLE_API_KEY="$HOME/geheim/AuthKey_ABCDE12345.p8"
export APPLE_API_KEY_ID="ABCDE12345"
export APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"
```

In der CI gibt es keinen Pfad auf deinem Rechner. Dort setzt du `APPLE_API_KEY_CONTENT` auf den Inhalt der `.p8` oder auf dessen Base64. `scripts/build-mac.sh` schreibt daraus `~/.lichtkammer-secrets/AuthKey.p8` und setzt `APPLE_API_KEY`. Die Datei liegt außerhalb des Projekts.

5. Prüfen, am Beispiel von Apple Silicon:

```bash
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Lichtkammer.app"
spctl --assess --type execute --verbose=4 "release/mac-arm64/Lichtkammer.app"
xcrun stapler validate "release/mac-arm64/Lichtkammer.app"
```

`spctl` meldet nach der Notarisierung „accepted“. Vorher, oder ganz ohne Zertifikat, bleibt der Rechtsklick-Weg gültig.

`build/entitlements.mac.plist` lässt Electron die gehärtete Laufzeit nutzen (JIT, nicht signierte Hilfsbibliotheken). Die Datei beim Signieren nicht entfernen, sonst startet die notariserte App nicht. Der Account Holder muss die aktuellen Verträge im Developer-Account angenommen haben, sonst lehnt der Notarisierungsdienst ab.

Ohne `CSC_LINK` und ohne Developer-ID-Zertifikat im Schlüsselbund bleibt der Build unsigniert. Leere Variablen behandelt `scripts/build-mac.sh` als nicht gesetzt.

### Linux

```bash
npm run dist:linux
```

Ergebnis: ein AppImage in `release/`.

### Alle drei Systeme

Auf GitHub, im privaten Repository [warscher80/lichtkammer](https://github.com/warscher80/lichtkammer), baut `.github/workflows/ci.yml` bei jedem Push auf `main` den Windows-Installer auf `windows-latest` und übersetzt die iPhone-App für den Simulator auf `macos-latest`. Die EXE liegt als Actions-Artefakt und als Release `windows-<Laufnummer>`. Ein eigener Mac ist dafür nicht nötig. `.github/workflows/installer.yml` baut die macOS-DMG, wenn ein Tag `v*` gepusht wird oder der Workflow von Hand startet. Ein Linux-Rechner kann das DMG nicht erzeugen.

Der macOS-Job signiert und notarisiert, sobald die Secrets aus dem Abschnitt oben gesetzt sind: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, und entweder `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` oder `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY_CONTENT`. Ohne diese Secrets bleibt die DMG unsigniert. TestFlight steht in [ios/ANLEITUNG.md](ios/ANLEITUNG.md).

## iPhone

Im Ordner `ios/` liegt dieselbe App als SwiftUI-Projekt für den eigenen Gebrauch. Sie liest die Mediathek über PhotoKit, legt Aussortiertes nur im Album „Lichtkammer – Aussortiert“ ab und sichert Entwicklungen als neue Fotos. RAW und ProRAW gehen über `CIRAWFilter`.

Team-ID und Bundle-ID stehen als Platzhalter in `ios/Config/Signing.xcconfig`. Die Installation auf dem eigenen iPhone über Xcode und der interne TestFlight-Upload (ohne öffentlichen App-Store-Release) stehen in [ios/ANLEITUNG.md](ios/ANLEITUNG.md), inklusive fastlane und dem Workflow `.github/workflows/testflight.yml`. Zum Bauen brauchst du einen Mac mit Xcode 16.

## Katalog

Der Katalog und die Vorschaubilder liegen im Benutzerverzeichnis der App (`userData`), nicht neben den Originalen. Entwicklungswerte, Schärfewerte und Hashes stehen in `catalog.json`.

## Technik

Electron, React, TypeScript und Tailwind. JPEG und PNG verarbeitet [sharp](https://sharp.pixelplumbing.com/). RAW-Sensordaten dekodiert [FlashRaw](https://flashraw.ybouane.com/) (WebAssembly, ohne nativen Neu-Bau pro Electron-Version) für CR2, CR3, NEF, ARW, DNG, RAF, ORF und weitere Formate derselben Bibliothek. Beides läuft in Worker-Threads, damit die Oberfläche bedienbar bleibt.

Die automatische Entwicklung ist ein klassisches Verfahren, kein KI-Modell: Weißabgleich über neutrale Mitteltöne, Belichtung mit Platz nach oben für die Lichter, eine weiche Schulter für die Lichter-Rückgewinnung, Klarheit als lokaler Mittelton-Kontrast, Dynamik, die Hauttöne ausnimmt, und Rauschreduzierung nur in glatten Flächen.
