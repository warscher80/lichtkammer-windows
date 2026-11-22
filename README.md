# Lichtkammer für Windows

Fotos sichten, mit einem Klick verschönern und sichern – die Windows-Version der Lichtkammer-App.

**Download:** [Lichtkammer-Setup.exe (neueste Version)](https://github.com/warscher80/lichtkammer-windows/releases/latest/download/Lichtkammer-Setup.exe)

Windows 10 und 11, 64 Bit. Keine weiteren Programme nötig.

## Installieren

1. `Lichtkammer-Setup.exe` herunterladen und doppelklicken.
2. Windows SmartScreen zeigt beim ersten Mal „Der Computer wurde durch Windows geschützt“, weil der Installer nicht signiert ist:
   **„Weitere Informationen“** anklicken, dann **„Trotzdem ausführen“**.
3. Lichtkammer installiert sich ohne weitere Fragen und startet. Eine Verknüpfung liegt auf dem Desktop und im Startmenü.

## So geht’s

1. **Ordner öffnen** oder **Fotos auswählen** (oder einfach einen Ordner ins Fenster ziehen).
2. **Doppelklick** auf ein Foto öffnet „Bearbeiten“.
3. Unten einen **Look** antippen (Automatik, Natürlich, Lebendig, Schwarzweiß, Film, Porträt, Landschaft, Nacht, Kühl, Warm, Dramatisch, Vintage) und mit **Stärke** dosieren.
4. Feinschliff rechts: Belichtung, Kontrast, Lichter, Tiefen, Weiß, Schwarz, Temperatur, Tönung (mit Auto-Weißabgleich), Dynamik, Sättigung, Farben einzeln (8 Farbbereiche), Klarheit, Schärfen, Rauschen, Himmel verbessern.
5. **Zuschneiden & Drehen**: Seitenverhältnis, Drehen um 90°, Begradigen.
6. **Alle sichern** schreibt alle behaltenen Fotos als JPEG in einen Ordner.

Zoom mit dem Mausrad, Doppelklick für 100 %, Bild mit der Maus verschieben. „Vorher/Nachher“ zeigt den Vergleich, die Taste **V** gedrückt halten zeigt das Original.

Originale werden nie verändert. Alle Einstellungen werden pro Foto gespeichert.
Unscharfe Bilder und Duplikate landen automatisch unter „Aussortiert“ und lassen sich wiederherstellen.

## Entwickeln

```bash
npm install
npm run dev        # App starten
npm run test       # Unit-Tests der Bildpipeline
npm run verify     # Prüfung mit den Beispielbildern
npm run dist:win   # Installer bauen (unter Windows)
```

Der Installer wird bei jedem Push auf `main` von GitHub Actions gebaut, getestet (Rauchtest der installierten App) und als Release veröffentlicht.

Technik: Electron, React, sharp (libvips) und eine eigene Farb-Pipeline in TypeScript. RAW-Dateien werden mit flashraw aus den Sensordaten entwickelt. Herkunft der Beispielbilder: `beispiele/QUELLEN.md`.
