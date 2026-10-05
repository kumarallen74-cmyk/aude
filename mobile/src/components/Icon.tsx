import type { LucideIcon } from 'lucide-react-native';
import Activity from 'lucide-react-native/icons/activity';
import BadgeCheck from 'lucide-react-native/icons/badge-check';
import BatteryCharging from 'lucide-react-native/icons/battery-charging';
import Bell from 'lucide-react-native/icons/bell';
import Cable from 'lucide-react-native/icons/cable';
import Camera from 'lucide-react-native/icons/camera';
import Car from 'lucide-react-native/icons/car';
import Check from 'lucide-react-native/icons/check';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CircleStop from 'lucide-react-native/icons/circle-stop';
import Clock from 'lucide-react-native/icons/clock';
import Copy from 'lucide-react-native/icons/copy';
import CreditCard from 'lucide-react-native/icons/credit-card';
import Download from 'lucide-react-native/icons/download';
import ExternalLink from 'lucide-react-native/icons/external-link';
import FileText from 'lucide-react-native/icons/file-text';
import Flag from 'lucide-react-native/icons/flag';
import Flashlight from 'lucide-react-native/icons/flashlight';
import Gauge from 'lucide-react-native/icons/gauge';
import Globe from 'lucide-react-native/icons/globe';
import Heart from 'lucide-react-native/icons/heart';
import Info from 'lucide-react-native/icons/info';
import Keyboard from 'lucide-react-native/icons/keyboard';
import Languages from 'lucide-react-native/icons/languages';
import Layers from 'lucide-react-native/icons/layers';
import List from 'lucide-react-native/icons/list';
import LocateFixed from 'lucide-react-native/icons/locate-fixed';
import Lock from 'lucide-react-native/icons/lock';
import LogOut from 'lucide-react-native/icons/log-out';
import Map from 'lucide-react-native/icons/map';
import MapPin from 'lucide-react-native/icons/map-pin';
import MessageCircle from 'lucide-react-native/icons/message-circle';
import Minus from 'lucide-react-native/icons/minus';
import Moon from 'lucide-react-native/icons/moon';
import Navigation from 'lucide-react-native/icons/navigation';
import Phone from 'lucide-react-native/icons/phone';
import PlugZap from 'lucide-react-native/icons/plug-zap';
import Plus from 'lucide-react-native/icons/plus';
import QrCode from 'lucide-react-native/icons/qr-code';
import Receipt from 'lucide-react-native/icons/receipt';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import Route from 'lucide-react-native/icons/route';
import ScanLine from 'lucide-react-native/icons/scan-line';
import Search from 'lucide-react-native/icons/search';
import Settings from 'lucide-react-native/icons/settings';
import Share2 from 'lucide-react-native/icons/share-2';
import ShieldCheck from 'lucide-react-native/icons/shield-check';
import SlidersHorizontal from 'lucide-react-native/icons/sliders-horizontal';
import Star from 'lucide-react-native/icons/star';
import Sun from 'lucide-react-native/icons/sun';
import Ticket from 'lucide-react-native/icons/ticket';
import Timer from 'lucide-react-native/icons/timer';
import Trash2 from 'lucide-react-native/icons/trash';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import User from 'lucide-react-native/icons/user';
import Wallet from 'lucide-react-native/icons/wallet';
import WifiOff from 'lucide-react-native/icons/wifi-off';
import X from 'lucide-react-native/icons/x';
import Zap from 'lucide-react-native/icons/zap';
import ZapOff from 'lucide-react-native/icons/zap-off';
import { useTheme } from '@/theme';

/** The app's icon set (Lucide, 2-pt stroke), imported per icon so only these ship in the bundle. */
const ICONS = {
  activity: Activity, badgeCheck: BadgeCheck, battery: BatteryCharging, bell: Bell, cable: Cable, camera: Camera, car: Car, check: Check,
  back: ChevronLeft, chevron: ChevronRight, alert: CircleAlert, stop: CircleStop, clock: Clock, copy: Copy, card: CreditCard,
  download: Download, external: ExternalLink, file: FileText, flag: Flag, torch: Flashlight, gauge: Gauge, globe: Globe, heart: Heart,
  info: Info, keyboard: Keyboard, languages: Languages, layers: Layers, list: List, locate: LocateFixed, lock: Lock, logout: LogOut,
  map: Map, pin: MapPin, chat: MessageCircle, minus: Minus, moon: Moon, navigate: Navigation, phone: Phone, plug: PlugZap, plus: Plus,
  qr: QrCode, receipt: Receipt, refresh: RefreshCw, route: Route, scan: ScanLine, search: Search, settings: Settings, share: Share2,
  shield: ShieldCheck, sliders: SlidersHorizontal, star: Star, sun: Sun, ticket: Ticket, timer: Timer, trash: Trash2, warning: TriangleAlert,
  user: User, wallet: Wallet, offline: WifiOff, close: X, bolt: Zap, boltOff: ZapOff,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 22, color, strokeWidth = 2, fill }: { name: IconName; size?: number; color?: string; strokeWidth?: number; fill?: string }) {
  const { c } = useTheme();
  const C = ICONS[name];
  return <C size={size} color={color ?? c.text} strokeWidth={strokeWidth} fill={fill ?? 'none'} accessibilityElementsHidden importantForAccessibility="no" />;
}
