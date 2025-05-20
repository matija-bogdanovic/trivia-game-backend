interface Data {
  details: Array<{ id: string; username: string; health: number }>;
  type: string;
  id?: string;
}
interface gameStartStats {
  type: string;
  isGameStarted: boolean;
  style: string;
  countdownNumber: number;
}
export interface RequestWithUser extends Request {
  user?: any; // Or define a more specific User interface
}