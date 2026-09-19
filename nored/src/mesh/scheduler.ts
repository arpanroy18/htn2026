import type { WirePacket } from './protocol';
import { priority } from './protocol.ts';

type Job = { peer: string; packet: WirePacket; rank: number; run: () => Promise<void>; resolve: () => void; reject: (e: Error) => void };
export class SendScheduler {
  private jobs: Job[] = [];
  private running = false;
  private lastPeer = '';
  private generation = 0;
  send(peer: string, packet: WirePacket, run: () => Promise<void>, rank = priority(packet)) {
    return new Promise<void>((resolve, reject) => {
      this.jobs.push({ peer, packet, rank, run, resolve, reject });
      void this.pump();
    });
  }
  cancel(peer?: string) {
    if (!peer) this.generation++;
    const keep: Job[] = [];
    for (const job of this.jobs) {
      if (!peer || job.peer === peer) job.reject(new Error('Transmission cancelled.'));
      else keep.push(job);
    }
    this.jobs = keep;
  }
  private async pump() {
    if (this.running) return;
    this.running = true;
    // Collect competing sends before selecting the next application packet.
    await Promise.resolve();
    try {
      while (this.jobs.length) {
        const rank = Math.min(...this.jobs.map((job) => job.rank));
        let index = this.jobs.findIndex((job) => job.rank === rank && job.peer !== this.lastPeer);
        if (index < 0) index = this.jobs.findIndex((job) => job.rank === rank);
        const job = this.jobs.splice(index, 1)[0];
        this.lastPeer = job.peer;
        const generation = this.generation;
        try {
          await job.run();
          if (generation !== this.generation) throw new Error('Transmission cancelled.');
          job.resolve();
        } catch (error) { job.reject(error instanceof Error ? error : new Error('Transmission failed.')); }
      }
    } finally { this.running = false; }
  }
}
