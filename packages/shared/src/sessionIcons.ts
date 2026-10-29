/**
 * A session's own icon: the namer picks one of these when it names
 * the session, and you can change it from its menu. Lucide icons (bundled with the client) that depict a subject:
 * no interface ones (arrows, chevrons, alignment), which would mean nothing as an avatar.
 */
export const SESSION_ICONS: readonly string[] = `
Accessibility Activity AlarmClock AlarmSmoke Anchor Antenna Anvil AppWindow Apple Archive ArchiveRestore
Armchair Atom Award Baby BadgeCheck BadgePercent Banknote Barcode BatteryCharging Beaker Bed Beer Bell
BellRing Bike Binary Binoculars Biohazard Bird Blocks Bomb Bone Book BookMarked BookOpen Bookmark Bot Box
Boxes Braces Brain BrainCircuit Brush Bug BugOff Building Building2 Bus Cable Cake Calculator Calendar
CalendarCheck CalendarClock Camera Car Carrot Castle Cat ChartArea ChartBar ChartCandlestick ChartLine
ChartNetwork ChartPie ChartScatter ChefHat Cherry Clapperboard ClipboardCheck ClipboardList Clock Cloud
CloudCog CloudDownload CloudLightning CloudRain CloudUpload Cloudy Code CodeXml Coffee Cog Coins Combine
Compass Component Cone Construction Contact Container Cookie Cpu CreditCard Crosshair Crown Cuboid CupSoda
Cylinder Database DatabaseZap Diamond Dice5 Dna Dog DollarSign Download Drill Droplet Droplets Earth Euro Eye
EyeOff Factory Feather Figma FileCode FileInput FileOutput FileSearch FileSpreadsheet FileText Files Film
Filter Fingerprint Fish Flag FlagTriangleRight Flame Flashlight FlaskConical FlaskRound Flower Focus Forklift
Frame Fuel Gamepad Gamepad2 Gauge Gem Ghost Gift GitBranch GitCommitHorizontal GitCompare GitFork GitMerge
GitPullRequest Github Gitlab Glasses Globe Hammer Hand Handshake HardDrive HardHat Headphones Headset Heart
HeartPulse Hexagon History Hospital Hotel Hourglass House Image Images Import Inbox Infinity Joystick Kanban
Key KeyRound Keyboard Lamp Landmark Languages Laptop Layers LayoutDashboard Leaf Library Lightbulb Link
ListChecks ListTodo Lock LockKeyhole Magnet Mail Map MapPin MapPinned Medal Megaphone MemoryStick Merge
MessageCircle MessageSquare MessagesSquare Mic Microscope Milestone Monitor MonitorSmartphone Moon Mountain
MountainSnow Mouse Music Navigation Network Newspaper Notebook NotebookPen NotepadText Orbit Package
PackageCheck PackageOpen Paintbrush Palette PanelsTopLeft Paperclip PawPrint PenLine PenTool Percent
PersonStanding Phone PhoneCall Pi Pickaxe PiggyBank Pill Pin Pizza Plane PlaneTakeoff Plug Plug2 PlugZap
Podcast PoundSterling Power Printer Puzzle Pyramid QrCode Quote Rabbit Radar Radiation Radio RadioTower
Rainbow Receipt Recycle RefreshCw Regex Repeat Rocket RotateCw Route Router Ruler Sailboat Satellite
SatelliteDish Scale ScanFace ScanLine ScanSearch School Scissors ScrollText Search SearchCheck Send Server
ServerCog Settings2 Shapes Share2 Sheet Shell Shield ShieldAlert ShieldCheck Ship Shirt ShoppingBag
ShoppingCart Shovel Shuffle Sigma Signature Signpost Siren Skull Smartphone Smile Snail Snowflake Sofa
Sparkles Speaker Split Sprout SquareTerminal Squirrel Star Stethoscope Sticker StickyNote Store Sun Sunrise
Sunset Sword Swords Syringe Table Tablet Tag Tags Target Telescope Tent Terminal TestTube TestTubes
Thermometer ThermometerSun Ticket Timer Tractor TrainFront Trash2 TreeDeciduous TreePine Trees TrendingDown
TrendingUp Triangle Trophy Truck Turtle Tv Umbrella Undo2 University Unlink Unplug Upload User UserCheck
UserCog Users Utensils Variable Vault Video Wallet Wand WandSparkles Warehouse Watch Waves Waypoints Webhook
Wifi Wind Wine Workflow Wrench Zap
`
  .trim()
  .split(/\s+/);

const ICON_SET = new Set(SESSION_ICONS);
/** One of the session icons (its exact name), else null. */
export const sessionIcon = (v: unknown): string | null => (typeof v === 'string' && ICON_SET.has(v) ? v : null);

/** Short joining words a title keeps in lower case (unless first or last). */
const MINOR = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'nor', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'vs', 'via', 'from', 'as', 'per']);

/**
 * A name in Title Case: every word capitalised except short joining words (not first or last); a word that already has a
 * capital past its first letter, or a digit, or a symbol (API, iOS, 2.4, ACME-5310, http-sink.ts) is left as it is.
 */
export function titleCase(name: string): string {
  const words = name.trim().split(/\s+/);
  return words
    .map((w, i) => {
      if (/[A-Z]/.test(w.slice(1)) || /[0-9._/\\:@#-]/.test(w)) return w;
      const low = w.toLowerCase();
      if (i > 0 && i < words.length - 1 && MINOR.has(low)) return low;
      return low.charAt(0).toUpperCase() + low.slice(1);
    })
    .join(' ');
}
